const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const zlib = require('zlib');

const BASE_URL = 'https://m.xinbisw.com';
const BOOK_ID = '22504';
const INDEX_PATH = `/ml/${BOOK_ID}/`;
const DELAY_MS = 800; // 每页请求间隔，避免过快
const PROGRESS_DIR = path.join(__dirname, '.progress');

// ============ 网络请求 ============

function fetch(url) {
  return new Promise((resolve, reject) => {
    const fullUrl = url.startsWith('http') ? url : BASE_URL + url;
    const mod = fullUrl.startsWith('https') ? https : http;

    const req = mod.get(fullUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Encoding': 'gzip, deflate',
        'Accept': 'text/html,application/xhtml+xml',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetch(res.headers.location));
      }

      const chunks = [];
      const stream = res.headers['content-encoding'] === 'gzip'
        ? res.pipe(zlib.createGunzip())
        : res.headers['content-encoding'] === 'deflate'
          ? res.pipe(zlib.createInflate())
          : res;

      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      stream.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout: ' + fullUrl)); });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============ 解析 ============

/** 解析单个目录页 */
function parseIndexPage(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const links = [];
  doc.querySelectorAll('.book_last dd a').forEach((a) => {
    const href = a.getAttribute('href');
    const title = a.textContent.trim();
    if (href && title) links.push({ href, title });
  });

  const bookTitle = doc.querySelector('dt')?.textContent?.replace('章节目录', '').trim() || '未知小说';

  // 获取所有分页链接：从 select>option 中提取
  const pageUrls = [];
  doc.querySelectorAll('.fenye select option').forEach((opt) => {
    const val = opt.getAttribute('value');
    if (val) pageUrls.push(val);
  });

  return { bookTitle, links, pageUrls };
}

/** 从目录页获取所有章节链接（自动翻页） */
async function fetchChapterList() {
  console.log('  加载目录第 1 页...');
  const html = await fetch(INDEX_PATH);
  const { bookTitle, links, pageUrls } = parseIndexPage(html);
  const allLinks = [...links];

  // 从第2页开始遍历剩余目录页
  for (let i = 1; i < pageUrls.length; i++) {
    console.log(`  加载目录第 ${i + 1}/${pageUrls.length} 页...`);
    await sleep(DELAY_MS);
    const pageHtml = await fetch(pageUrls[i]);
    const { links: pageLinks } = parseIndexPage(pageHtml);
    allLinks.push(...pageLinks);
  }

  return { bookTitle, chapters: allLinks };
}

/** 解析单个页面的正文段落 + 下一页/下一章链接 */
function parsePage(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const content = doc.getElementById('chaptercontent');
  const paragraphs = [];

  if (content) {
    content.querySelectorAll('p').forEach((p) => {
      const text = p.textContent.trim();
      // 过滤广告和提示性文字
      if (!text) return;
      if (text.includes('请点击下一页继续阅读')) return;
      if (text.includes('新笔书屋更新速度')) return;
      if (text.includes('侵犯了您的权益')) return;
      if (text.includes('xinbisw.com')) return;
      paragraphs.push(text);
    });
  }

  // 查找"下一页"或"下一章"链接
  const nextLink = doc.querySelector('a.js_page_down');
  let nextUrl = null;
  let isNextChapter = false;

  if (nextLink) {
    nextUrl = nextLink.getAttribute('href');
    const linkText = nextLink.textContent.trim();
    isNextChapter = linkText.includes('下一章');
  }

  // 章节标题（去掉分页标记）
  const titleEl = doc.getElementById('nr_title');
  let chapterTitle = '';
  if (titleEl) {
    chapterTitle = titleEl.textContent.trim().replace(/\(\d+\/\d+\)/, '').trim();
  }

  return { paragraphs, nextUrl, isNextChapter, chapterTitle };
}

/** 爬取一整章（可能有多页） */
async function fetchFullChapter(firstPageUrl) {
  let allParagraphs = [];
  let url = firstPageUrl;
  let chapterTitle = '';

  while (url) {
    const html = await fetch(url);
    const { paragraphs, nextUrl, isNextChapter, chapterTitle: title } = parsePage(html);

    if (!chapterTitle && title) chapterTitle = title;
    allParagraphs = allParagraphs.concat(paragraphs);

    if (isNextChapter || !nextUrl) break; // 到下一章了，停止
    url = nextUrl;
    await sleep(DELAY_MS);
  }

  return { chapterTitle, paragraphs: allParagraphs };
}

// ============ 去重 ============

/**
 * 去除连续两章之间的重复段落
 * 如果当前章节开头的若干段落与上一章结尾相同，则去掉这些重复段落
 */
function dedup(prevParagraphs, currParagraphs) {
  if (!prevParagraphs || prevParagraphs.length === 0) return currParagraphs;

  // 取上一章最后 N 段作为比对窗口
  const windowSize = Math.min(20, prevParagraphs.length);
  const tailSet = new Set(prevParagraphs.slice(-windowSize));

  // 找当前章节开头连续与上一章尾部重复的段落数
  let overlapCount = 0;
  for (let i = 0; i < currParagraphs.length && i < windowSize; i++) {
    if (tailSet.has(currParagraphs[i])) {
      overlapCount++;
    } else {
      break; // 不再连续重复，停止
    }
  }

  if (overlapCount > 0) {
    console.log(`  [去重] 去除开头 ${overlapCount} 个重复段落`);
  }

  return currParagraphs.slice(overlapCount);
}

// ============ 断点续爬 ============
// 进度文件按 书名 存放在 .progress/ 目录下，与具体网站无关
// 记录: { bookTitle, outputFile, completedIndex, prevTailParagraphs }

function getProgressFile(bookTitle) {
  if (!fs.existsSync(PROGRESS_DIR)) fs.mkdirSync(PROGRESS_DIR, { recursive: true });
  // 用书名做文件名，去除不安全字符
  const safeName = bookTitle.replace(/[<>:"/\\|?*]/g, '_');
  return path.join(PROGRESS_DIR, `${safeName}.json`);
}

function loadProgress(bookTitle) {
  const file = getProgressFile(bookTitle);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function saveProgress(bookTitle, outputFile, completedIndex, prevTailParagraphs) {
  const file = getProgressFile(bookTitle);
  const data = {
    bookTitle,
    outputFile,
    completedIndex,
    // 只保留上一章最后 20 段用于去重，避免进度文件过大
    prevTailParagraphs: (prevTailParagraphs || []).slice(-20),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

function clearProgress(bookTitle) {
  const file = getProgressFile(bookTitle);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

// ============ 主流程 ============

async function main() {
  console.log('正在获取章节目录...');
  const { bookTitle, chapters } = await fetchChapterList();
  console.log(`小说名: ${bookTitle}`);
  console.log(`共 ${chapters.length} 章\n`);

  const outputFile = path.join(__dirname, `${bookTitle}.txt`);

  // 尝试加载进度
  const progress = loadProgress(bookTitle);
  let startIndex = 0;
  let prevParagraphs = [];

  if (progress && progress.completedIndex >= 0) {
    startIndex = progress.completedIndex + 1;
    prevParagraphs = progress.prevTailParagraphs || [];
    console.log(`[断点续爬] 检测到上次进度，从第 ${startIndex + 1} 章继续（已完成 ${startIndex}/${chapters.length}）\n`);
  } else {
    // 全新开始，写入文件头
    fs.writeFileSync(outputFile, `${bookTitle}\n${'='.repeat(40)}\n\n`, 'utf-8');
  }

  if (startIndex >= chapters.length) {
    console.log('所有章节已爬取完毕！');
    clearProgress(bookTitle);
    return;
  }

  for (let i = startIndex; i < chapters.length; i++) {
    const ch = chapters[i];
    console.log(`[${i + 1}/${chapters.length}] ${ch.title}`);

    try {
      const { chapterTitle, paragraphs } = await fetchFullChapter(ch.href);
      const displayTitle = chapterTitle || ch.title;

      // 去重
      const cleaned = dedup(prevParagraphs, paragraphs);

      // 追加写入
      const text = `${displayTitle}\n\n${cleaned.join('\n\n')}\n\n\n`;
      fs.appendFileSync(outputFile, text, 'utf-8');

      prevParagraphs = paragraphs; // 保留原始段落用于下一章去重

      // 每章完成后保存进度
      saveProgress(bookTitle, outputFile, i, paragraphs);

      await sleep(DELAY_MS);
    } catch (err) {
      console.error(`  [错误] ${ch.title}: ${err.message}`);
      // 出错也保存当前进度（不更新 completedIndex，下次重试该章）
      await sleep(3000);
    }
  }

  // 全部完成，清理进度文件
  clearProgress(bookTitle);
  console.log(`\n完成！已保存到: ${outputFile}`);
}

main().catch(console.error);
