const {Cluster} =require('puppeteer-cluster');
const urllib=require('url');
const fs=require('fs');
const bloomfilter=require("./bloomfilter");
const dbcrawler=require('../../db/dbcrawler');
const handleurl=require('./handleurl');
const sqlscan=require('../vulncrawler/sql');
const xssscan=require('../vulncrawler/xss');

var count=0;
var urlFilter=new bloomfilter(10000,0.01);//去掉重复的url
var similarUrlFilter=new bloomfilter(10000,0.01);//去掉相似的url
const launchOptions = {
    headless: true,
    ignoreHTTPSErrors: true,        // 忽略证书错误
    waitUntil: 'networkidle2',
    defaultViewport:{
        width: 1920,
        height: 1080
    },
    args: [
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-xss-auditor',    // 关闭 XSS Auditor
        '--no-zygote',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--allow-running-insecure-content',     // 允许不安全内容
        '--disable-webgl',
        '--disable-popup-blocking',
        //'--proxy-server=http://127.0.0.1:8080'      // 配置代理
    ]
    // "executablePath": "Chromium_OSX.app/Contents/MacOS/Chromium",       // 配置chromium路径

};

const clusterLanuchOptions = {
    concurrency: Cluster.CONCURRENCY_PAGE,  // 单Chrome多tab模式
    maxConcurrency:  10,  // 并发的workers数
    retryLimit: 2,   // 重试次数
    skipDuplicateUrls: true,  // 不爬重复的url
    monitor: true,  // 显示性能消耗
    puppeteerOptions: launchOptions,
};
//得到src和href的链接
function get_src_and_href_links(nodes) {
    let result = [];
    for(let node of nodes){
        let src = node.getAttribute("src");
        let href = node.getAttribute("href");
        if (src){
            result.push(src)
        }
        if (href){
            result.push(href);
        }
    }
    return result;

}

//对爬到的链接进行清洗
async function parseLinks(links, url) {

    let result = [];


    for(let link of links){
        let parsedLink = urllib.parse(link);
        let hostname = parsedLink.hostname;       // 主机名不带端口号
        //排除根目录情况
        if(parsedLink.pathname=="/"||parsedLink.pathname=="#"||parsedLink.pathname=="/#"){
            continue;
        }

        // 处理相对路径
        if(hostname == null&& link.indexOf("javascript:")!==0){
            let old_link = link;
            link = urllib.resolve(url, link);
            console.log(`[*] relative url: ${old_link} => ${link}`);
        }
        // 相对路径还有一种是不以/开头的，如：resource.root/assets/images/favicon.ico

        // 处理url以 // 开头的情况
        if(link.indexOf("//") === 0){
            console.log(`[*] link start from "//" : ${link}`);
            link = "http:" + link;
        }



        if(link.indexOf("http") === -1){
            // 除上述情况外均为不合法URL,丢弃
            console.log(`[*] invalid link: ${link}`);
            continue;
        }

        // 检测是否在爬行范围
        parsedLink = urllib.parse(link);
        if(url.indexOf(parsedLink.hostname)===-1){
            console.log(`[*] Link not in scope: ${link}`);
            continue
        }
        if(urlFilter.contain(link)){
            continue;
        }
        else {
            urlFilter.add(link);
        }
        result.push(link);

    }
    return result;
}


function isStaticLink(link){
    parsedLink = urllib.parse(link);
    // 去除静态文件
    let blacklists = ['css', 'js', 'jpg', 'png', 'gif', 'svg'];
    if(parsedLink.pathname){
        let filename = parsedLink.pathname.split('/').pop();
        if(blacklists.indexOf(filename.split(".").pop()) !== -1){
            return true;

        }
    }
    return false;

}

async function preparePage(page){
    const userAgent = 'Mozilla/5.0 (X11; Linux x86_64)' +
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/64.0.3282.39 Safari/537.36';
    await page.setUserAgent(userAgent);

    // Pass the Webdriver Test.
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', {
            get: () => false,
        });
    });

    // Pass the Chrome Test.
    await page.evaluateOnNewDocument(() => {
        // We can mock this in as much depth as we need for the test.
        window.navigator.chrome = {
            runtime: {},
            // etc.
        };
    });
}


function executeEvent() {
    var firedEventNames = ["focus", "mouseover", "mousedown", "click", "error"];
    var firedEvents = {};
    var length = firedEventNames.length;
    for (let i = 0; i < length; i++) {
        firedEvents[firedEventNames[i]] = document.createEvent("HTMLEvents");
        firedEvents[firedEventNames[i]].initEvent(firedEventNames[i], true, true);
    }
    var eventLength = window.eventNames.length;
    for (let i = 0; i < eventLength; i++) {
        var eventName =  window.eventNames[i].split("_-_")[0];
        var eventNode =  window.eventNodes[i];
        var index = firedEventNames.indexOf(eventName);
        if (index > -1) {
            if (eventNode != undefined) {
                eventNode.dispatchEvent(firedEvents[eventName]);
            }
        }
    }
    let result = window.info.split("_-_");
    result.splice(0,1);
    return result;
}


async function launchFromWebApi(siteshash,form) {
    /*
    * siteshash:站点的唯一标识字符串
    * form
    * */
    var target=form.sites;//扫描的目标站点
    var option=form.vulns;//检测选择 xss sql
    const cluster = await Cluster.launch(clusterLanuchOptions);
    //去掉网站的/
    if(target.endsWith("/")) target=target.substr(0,target.length-1);
    urlFilter.add(target);
    await cluster.task(async ({ page, data: url }) => {
        await preparePage(page);
        await page.setRequestInterception(true);     // 开启拦截功能
        await page.on('request', interceptedRequest => {
            // 拦截图片请求 => 返回假的图片资源
            // if (interceptedRequest.url().endsWith('.png') || interceptedRequest.url().endsWith('.jpg') || interceptedRequest.url().endsWith('.gif'))
            //     interceptedRequest.abort();
            if (interceptedRequest.resourceType() === 'image' || interceptedRequest.url().endsWith('.ico')) {
                //console.log(`abort image: ${interceptedRequest.url()}`);
                let images = fs.readFileSync('public/image.png');
                interceptedRequest.respond({
                    'contentType': ' image/png',
                    'body': Buffer.from(images)
                });
            }
            else if(interceptedRequest.url().indexOf("logout") !== -1){
                interceptedRequest.abort();
            }
            else
                interceptedRequest.continue();
        });
        await page.on('dialog', async dialog => {
            await dialog.dismiss();
        });

        //处理跳转
        await page.on('response', interceptedResponse =>{
            let status = interceptedResponse.status();
            if(status.toString().substr(0,2) === "30"){
                console.log("url: " + interceptedResponse.url());
                console.log("status: " + status);
                console.log("headers: " + interceptedResponse.headers().location);

                // 添加进任务队列
                cluster.queue(interceptedResponse.headers().location);
            }
        });
        console.log("current url:" + url);

        await page.goto(url, {
            timeout: 40 * 1000,
            waitUntil: 'networkidle2'
        });
        // 收集标签的URL
        const links = await page.$$eval('[src],[href],[action],[data-url],[longDesc],[lowsrc]', get_src_and_href_links);

        let urls = await parseLinks(links, url);

        await dbcrawler.addCrawlersByUrls(siteshash,urls);//保存爬取的链接数据

        //console.log("收集标签属性URL: " + urls);

        // 触发DOM事件&收集URL
       // const domLinks = await page.evaluate(executeEvent);
       // console.log(domLinks);
       // const domUrls = await parseLinks(domLinks, url);
       // console.log("收集DOM事件URL: " + domUrls);
        //urls = domUrls.concat(urls);
        for(let u of urls){
            //去除静态文件
            if(isStaticLink(u)){
                continue;
            }
            let urlhash= handleurl.getUrlHash(u);
            if(similarUrlFilter.contain(urlhash)){
               continue;
           }else{
                similarUrlFilter.add(urlhash);
                if(option==='1'){
                    await sqlscan(siteshash,u);//检测SQL漏洞
                    await xssscan(siteshash,u);//检测XSS漏洞

                }else if(option==='2'){
                    await sqlscan(siteshash,u);//检测SQL漏洞

                }else if(option==='3'){
                    await xssscan(siteshash,u);//检测XSS漏洞

                }else{

                }


                cluster.queue(u);
           }

        }

    });


        if(target.indexOf("http") === -1){
            target = "http://" + target
        }
        cluster.queue(target);



    await cluster.idle();
    await cluster.close();
}
module.exports=launchFromWebApi;