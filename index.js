import readline from 'readline'
import getMAC from 'getmac'
import plist from 'plist'
import fs from 'fs'
import {pipeline} from 'node:stream/promises'
import progress from 'progress-stream'
import JSZip from 'jszip'

const email = process.env.EMAIL
const password = process.env.PASSWORD

const search = async keyword => {
    const params = new URLSearchParams({
        term: keyword,
        country: 'CN',
        entity: 'software',
        explicit: 'no',
        limit: 5
    })
    
    const url = 'https://itunes.apple.com/search?' + params
    const response = await fetch(url)
    const res = await response.json()
    return res.results.map(item => {
        return {
            id: item.trackId,
            name: item.trackName
        }
    })
}

const getInputManager = () => {
    
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    })
    
    return {
        async ask(question) {
            return new Promise(resolve => {
                rl.question(question, answer => {
                    resolve(answer)
                })
            })
        },
        close() {
            rl.close()
        }
    }
    
}

const guid = getMAC().replace(/:/g, '').toUpperCase()

const getCookie = response => {
    const setCookie = response.headers.getSetCookie()
    return setCookie.map(entry => entry.split(';')[0]).join('; ')
}

const getLoginInfo = async (email, password, mfa) => {
    const data = {
        appleId: email,
        createSession: 'true',
        guid: guid,
        rmp: 0,
        why: 'signIn',
    }
    
    if (mfa) {
        data.attempt = 2
        data.password = password + mfa
    } else {
        data.attempt = 4
        data.password = password
    }
    
    const body = plist.build(data)
    
    const url = 'https://auth.itunes.apple.com/auth/v1/native/fast?guid=' + guid
    const response = await fetch(url, {
        method: 'POST',
        body: body,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Configurator/2.15 (Macintosh; OS X 11.0.0; 16G29) AppleWebKit/2603.3.8',
        },
    })
    
    const text = await response.text()
    const cookie = getCookie(response)
    const info = plist.parse(text)
    
    return {cookie, info}
}

const listVersion = async (loginInfo, id) => {
    const data = {
        creditDisplay: '',
        guid: guid,
        salableAdamId: id
    }
    
    const cookie = loginInfo.cookie
    const user = loginInfo.info
    
    const body = plist.build(data)
    const url = 'https://p32-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=' + guid
    const response = await fetch(url, {
        method: 'POST',
        body: body,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': cookie,
            'User-Agent': 'Configurator/2.15 (Macintosh; OS X 11.0.0; 16G29) AppleWebKit/2603.3.8',
            'X-Dsid': user.dsPersonId,
            'iCloud-DSID': user.dsPersonId
        },
    })
    
    const text = await response.text()
    const info = plist.parse(text)
    const app = info.songList[0]
    return app.metadata.softwareVersionExternalIdentifiers.reverse()
}

const getVersionInfo = async (loginInfo, id, versionId) => {
    const data = {
        creditDisplay: '',
        guid: guid,
        salableAdamId: id,
        externalVersionId: versionId
    }
    const cookie = loginInfo.cookie
    const user = loginInfo.info
    const body = plist.build(data)
    const url = 'https://p25-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=' + guid
    const response = await fetch(url, {
        method: 'POST',
        body: body,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': cookie,
            'User-Agent': 'Configurator/2.15 (Macintosh; OS X 11.0.0; 16G29) AppleWebKit/2603.3.8',
            'X-Dsid': user.dsPersonId,
            'iCloud-DSID': user.dsPersonId
        },
    })
    
    const text = await response.text()
    const info = plist.parse(text)
    return info.songList[0]
}

const download = async (url, fileName) => {
    
    fs.rmSync(fileName, {force: true})
    
    const response = await fetch(url)
    const contentLength = response.headers.get('content-length')
    const totalSize = parseInt(contentLength, 10)
    
    const progressStream = progress({
        length: totalSize,
        time: 100
    })
    
    const formatSpeed = bytes => {
        const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
        let l = 0, n = parseInt(bytes, 10) || 0
        while (n >= 1024 && ++l) {
            n = n / 1024
        }
        return (n.toFixed(n >= 10 || l < 1 ? 0 : 1) + ' ' + units[l])
    }
    
    progressStream.on('progress', progress => {
        const percentage = Math.floor(progress.percentage)
        const transferred = progress.transferred
        const speed = progress.speed
        console.log(`进度: ${percentage}% | 已传输: ${formatSpeed(transferred)} | 速度: ${formatSpeed(speed)}/s`)
    })
    const writer = fs.createWriteStream(fileName)
    await pipeline(response.body, progressStream, writer)
}

const addSignature = async (fileName, versionInfo, email, output) => {
    fs.rmSync(output, {force: true})
    
    const metadata = JSON.parse(JSON.stringify(versionInfo.metadata))
    metadata['apple-id'] = email
    metadata['userName'] = email
    metadata['appleId'] = email
    const signature = versionInfo.sinfs.find(sinf => sinf.id === 0)
    
    const content = fs.readFileSync(fileName)
    const archive = await JSZip.loadAsync(content)
    
    const metadataPlist = plist.build(metadata)
    archive.file('iTunesMetadata.plist', Buffer.from(metadataPlist, 'utf8'))
    
    const manifestFile = archive.file(/\.app\/SC_Info\/Manifest\.plist$/)[0]
    const manifestContent = await manifestFile.async('string')
    const manifest = plist.parse(manifestContent || '<plist></plist>')
    const sinfPath = manifest.SinfPaths[0]
    const appBundleName = manifestFile.name.split('/')[1].replace(/\.app$/, '')
    const signatureTargetPath = `Payload/${appBundleName}.app/${sinfPath}`
    archive.file(signatureTargetPath, Buffer.from(signature.sinf, 'base64'))
    
    const zipOptions = {streamFiles: true, compression: 'DEFLATE', compressionOptions: {level: 9}}
    const zipStream = archive.generateNodeStream(zipOptions)
    const outputStream = fs.createWriteStream(output)
    
    await pipeline(zipStream, outputStream)
    
}

setTimeout(async () => {
    const inputManager = getInputManager()
    try {
        const keyword = await inputManager.ask('请输入应用名称: ')
        const res = await search(keyword)
        console.log('搜索结果', res)
        const appId = await inputManager.ask('请输入应用id: ')
        let loginInfo = await getLoginInfo(email, password)
        
        if (loginInfo.info.customerMessage === 'MZFinance.BadLogin.Configurator_message') {
            const mfa = await inputManager.ask('请输入MFA: ')
            loginInfo = await getLoginInfo(email, password, mfa)
        }
        
        const versions = await listVersion(loginInfo, appId)
        console.log('版本列表', versions)
        const versionId = await inputManager.ask('请输入版本id: ')
        const versionInfo = await getVersionInfo(loginInfo, appId, versionId)
        const metadata = versionInfo.metadata
        const tmpFile = metadata.bundleDisplayName + '-' + metadata.bundleVersion + '.tmp'
        console.log('下载地址', versionInfo.URL)
        console.log('开始下载')
        await download(versionInfo.URL, tmpFile)
        console.log('下载完成')
        const output = metadata.bundleDisplayName + '-' + metadata.bundleVersion + '.ipa'
        console.log('添加签名')
        await addSignature(tmpFile, versionInfo, email, output)
        console.log('清理缓存')
        fs.rmSync(tmpFile)
        console.log('获取成功')
    } catch (error) {
        console.log('获取出错', error)
    } finally {
        inputManager.close()
    }
    
})

