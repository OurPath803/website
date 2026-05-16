#!/usr/bin/env node
/**
 * build-blog.js — generates the public website's blog from Notion at build time.
 *
 * Run during Netlify build (see netlify.toml). On every deploy:
 *   1. Pull all "Published" posts from the Notion database (filtering out Members-only).
 *   2. Download each post's cover + inline images to ./blog-images/<hash>.<ext>.
 *   3. Render ./blog.html  (index page, replacing the placeholder)
 *           and ./blog/<slug>.html  (one per post).
 *
 * To trigger a rebuild when you publish a new post in Notion:
 *   Notion → integration webhook → Netlify build hook URL.
 *   (One-time setup, then publishing in Notion → live in ~60s.)
 *
 * Env vars (set in Netlify UI):
 *   NOTION_TOKEN              — internal integration secret
 *   NOTION_DATABASE_ID        — 1dd52d69-3050-4ed4-a85d-130bde572558
 *
 * Requires Node 18+ (uses global fetch). The website folder has no other
 * Node deps; this script is intentionally zero-dependency.
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const NOTION_API = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'

const NOTION_TOKEN = process.env.NOTION_TOKEN
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID

const ROOT = path.resolve(__dirname, '..')                  // website/
const POSTS_DIR = path.join(ROOT, 'blog')                   // website/blog/<slug>.html
const IMAGES_DIR = path.join(ROOT, 'blog-images')           // website/blog-images/

if (!NOTION_TOKEN || !NOTION_DATABASE_ID) {
  console.error('[build-blog] NOTION_TOKEN or NOTION_DATABASE_ID missing — skipping blog build.')
  console.error('             (Static blog.html will remain as-is.)')
  process.exit(0) // soft-skip so Netlify deploy doesn't fail on first run
}

// ────────────────────────────────────────────────────────────────────────────
// Notion API
// ────────────────────────────────────────────────────────────────────────────
function notionHeaders() {
  return {
    'Authorization': `Bearer ${NOTION_TOKEN}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  }
}

async function notionFetch(p, opts = {}) {
  const res = await fetch(`${NOTION_API}${p}`, {
    ...opts,
    headers: { ...notionHeaders(), ...(opts.headers || {}) },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Notion ${res.status}: ${body}`)
  }
  return res.json()
}

async function queryPublishedPosts() {
  const data = await notionFetch(`/databases/${NOTION_DATABASE_ID}/query`, {
    method: 'POST',
    body: JSON.stringify({
      filter: {
        and: [
          { property: 'Status', select: { equals: 'Published' } },
          { property: 'Members only', checkbox: { equals: false } },
        ],
      },
      sorts: [{ property: 'Publish date', direction: 'descending' }],
      page_size: 100,
    }),
  })
  return data.results || []
}

async function getPageBlocks(pageId) {
  const blocks = []
  let cursor
  do {
    const url = `/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`
    const data = await notionFetch(url)
    blocks.push(...(data.results || []))
    cursor = data.has_more ? data.next_cursor : null
  } while (cursor)
  return blocks
}

// ────────────────────────────────────────────────────────────────────────────
// Image download + local rehosting (Notion URLs expire after ~1h)
// ────────────────────────────────────────────────────────────────────────────
async function downloadImage(url) {
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true })
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16)
  // Guess extension from URL path (Notion S3 URLs include the original ext)
  const m = url.split('?')[0].match(/\.(jpg|jpeg|png|webp|gif|svg)$/i)
  const ext = m ? m[1].toLowerCase() : 'jpg'
  const filename = `${hash}.${ext}`
  const dest = path.join(IMAGES_DIR, filename)
  if (fs.existsSync(dest)) return `/blog-images/${filename}`

  const res = await fetch(url)
  if (!res.ok) {
    console.warn(`[build-blog] image fetch failed (${res.status}) — ${url}`)
    return null
  }
  const buf = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(dest, buf)
  return `/blog-images/${filename}`
}

// ────────────────────────────────────────────────────────────────────────────
// Notion blocks → HTML
// ────────────────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  }[c]))
}

function renderRichText(rich = []) {
  return rich.map(rt => {
    let text = escapeHtml(rt.plain_text || '')
    const ann = rt.annotations || {}
    if (ann.code) text = `<code>${text}</code>`
    if (ann.bold) text = `<strong>${text}</strong>`
    if (ann.italic) text = `<em>${text}</em>`
    if (ann.strikethrough) text = `<del>${text}</del>`
    if (ann.underline) text = `<u>${text}</u>`
    if (rt.href) text = `<a href="${escapeHtml(rt.href)}" rel="noopener">${text}</a>`
    return text
  }).join('')
}

function getImageUrl(block) {
  const img = block.image
  if (!img) return null
  return img.type === 'external' ? img.external.url : img.file.url
}

async function blocksToHtml(blocks) {
  const out = []
  let listType = null
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null } }

  for (const b of blocks) {
    const type = b.type
    const data = b[type] || {}

    if (type === 'bulleted_list_item' || type === 'numbered_list_item') {
      const wanted = type === 'bulleted_list_item' ? 'ul' : 'ol'
      if (listType !== wanted) { closeList(); out.push(`<${wanted}>`); listType = wanted }
      out.push(`<li>${renderRichText(data.rich_text)}</li>`)
      continue
    }
    closeList()

    switch (type) {
      case 'paragraph': {
        const html = renderRichText(data.rich_text)
        out.push(html ? `<p>${html}</p>` : '<p>&nbsp;</p>')
        break
      }
      case 'heading_1': out.push(`<h2>${renderRichText(data.rich_text)}</h2>`); break
      case 'heading_2': out.push(`<h3>${renderRichText(data.rich_text)}</h3>`); break
      case 'heading_3': out.push(`<h4>${renderRichText(data.rich_text)}</h4>`); break
      case 'quote':     out.push(`<blockquote>${renderRichText(data.rich_text)}</blockquote>`); break
      case 'divider':   out.push('<hr/>'); break
      case 'code':
        out.push(`<pre><code>${escapeHtml(data.rich_text?.map(r => r.plain_text).join('') || '')}</code></pre>`)
        break
      case 'image': {
        const url = getImageUrl(b)
        if (url) {
          const local = await downloadImage(url)
          if (local) {
            const alt = data.caption?.[0]?.plain_text || ''
            const captionHtml = renderRichText(data.caption || [])
            out.push(`<figure><img src="${escapeHtml(local)}" alt="${escapeHtml(alt)}" loading="lazy"/>${captionHtml ? `<figcaption>${captionHtml}</figcaption>` : ''}</figure>`)
          }
        }
        break
      }
      case 'callout': out.push(`<aside class="callout">${renderRichText(data.rich_text)}</aside>`); break
      default:
        if (data.rich_text) {
          const html = renderRichText(data.rich_text)
          if (html) out.push(`<p>${html}</p>`)
        }
    }
  }
  closeList()
  return out.join('\n')
}

// ────────────────────────────────────────────────────────────────────────────
// Property mapping
// ────────────────────────────────────────────────────────────────────────────
const getProp = (p, n) => p.properties?.[n]
const getTitle = p => getProp(p, 'Title')?.title?.map(t => t.plain_text).join('') || 'Untitled'
const getRichTextProp = (p, n) => getProp(p, n)?.rich_text?.map(t => t.plain_text).join('') || ''
const getDate = (p, n) => getProp(p, n)?.date?.start || null
const getMultiSelect = (p, n) => (getProp(p, n)?.multi_select || []).map(o => o.name)
function getCoverUrl(p) {
  if (!p.cover) return null
  return p.cover.type === 'external' ? p.cover.external.url : p.cover.file.url
}

function formatDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

async function mapPage(page) {
  const coverRaw = getCoverUrl(page)
  return {
    title: getTitle(page),
    slug: getRichTextProp(page, 'Slug'),
    excerpt: getRichTextProp(page, 'Excerpt'),
    date: getDate(page, 'Publish date'),
    dateFormatted: formatDate(getDate(page, 'Publish date')),
    tags: getMultiSelect(page, 'Tags'),
    author: getRichTextProp(page, 'Author'),
    cover: coverRaw ? await downloadImage(coverRaw) : null,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// HTML templates (match the existing site's styling — uses styles.css classes)
// ────────────────────────────────────────────────────────────────────────────
function indexPage(posts) {
  const cards = posts.map((p, i) => `
      <a href="/blog/${escapeHtml(p.slug)}" class="blog-card reveal${i ? ` reveal-delay-${Math.min(i, 3)}` : ''}" style="text-decoration:none;color:inherit;display:block;">
        ${p.cover ? `<img src="${escapeHtml(p.cover)}" alt="" style="width:100%;height:200px;object-fit:cover;border-radius:6px 6px 0 0;display:block;"/>` : ''}
        <div style="padding:1.5rem;">
          <div class="blog-date">${escapeHtml(p.dateFormatted)}</div>
          <h3>${escapeHtml(p.title)}</h3>
          <p>${escapeHtml(p.excerpt)}</p>
          <span class="card-cta">Read more &#8594;</span>
        </div>
      </a>
  `).join('\n')

  return BLOG_INDEX_HTML.replace('<!-- POSTS -->', cards || '<p style="text-align:center;color:var(--subtle);">No posts published yet.</p>')
}

function postPage(post, bodyHtml) {
  return BLOG_POST_HTML
    .replace(/{{TITLE}}/g, escapeHtml(post.title))
    .replace('{{EXCERPT}}', escapeHtml(post.excerpt))
    .replace('{{DATE}}', escapeHtml(post.dateFormatted))
    .replace('{{AUTHOR}}', escapeHtml(post.author || ''))
    .replace('{{COVER}}', post.cover ? `<img src="${escapeHtml(post.cover)}" alt="" style="width:100%;border-radius:8px;margin-bottom:2rem;"/>` : '')
    .replace('{{BODY}}', bodyHtml)
    .replace('{{TAGS}}', post.tags.length ? post.tags.map(t => `<span style="font-size:.75rem;color:var(--subtle);text-transform:uppercase;letter-spacing:.06em;margin-right:.5rem;">#${escapeHtml(t)}</span>`).join('') : '')
}

const SHARED_NAV = `
<nav id="nav">
  <div class="container">
    <a href="/" class="nav-logo"><img src="/ourpath-horizontal-dark.png" alt="OurPath Guidance" style="height:44px;width:auto;display:block;"></a>
    <button class="nav-toggle" onclick="document.querySelector('.nav-links').classList.toggle('open')" aria-label="Menu"><span></span><span></span><span></span></button>
    <ul class="nav-links">
      <li><a href="/mentoring">Mentoring</a></li>
      <li><a href="/our-story">Our Story</a></li>
      <li><a href="/blog" class="active">Blog</a></li>
      <li><a href="/contact">Contact</a></li>
      <li><a href="https://portal.ourpathguidance.co.uk/login" class="nav-btn-ghost">Sign in</a></li>
      <li><a href="https://portal.ourpathguidance.co.uk/session-zero" class="nav-btn-filled">Begin Session Zero</a></li>
    </ul>
  </div>
</nav>`

const SHARED_FOOTER = `
<footer>
  <div class="container">
    <div class="footer-content">
      <div class="footer-brand">
        <div class="nav-logo"><img src="/ourpath-horizontal-dark.png" alt="OurPath Guidance" style="height:36px;width:auto;display:block;margin-bottom:.5rem;"></div>
        <p>Personal development through guidance and mentoring. Reflective practice rooted in tradition, designed for modern life.</p>
      </div>
      <div class="footer-links"><h4>Navigate</h4><ul><li><a href="/#approach">Our Approach</a></li><li><a href="/mentoring">Mentoring</a></li><li><a href="/our-story">Our Story</a></li><li><a href="/blog">Blog</a></li><li><a href="/contact">Contact</a></li></ul></div>
      <div class="footer-links"><h4>Get Started</h4><ul><li><a href="https://portal.ourpathguidance.co.uk/session-zero">Begin Session Zero</a></li><li><a href="https://portal.ourpathguidance.co.uk/login">Sign in to Portal</a></li><li><a href="/referral">Referral Form</a></li></ul></div>
      <div class="footer-links"><h4>Connect</h4><ul><li><a href="#">Instagram</a></li><li><a href="#">LinkedIn</a></li><li><a href="#">TikTok</a></li><li><a href="/contact">Email</a></li></ul></div>
    </div>
    <div class="footer-bottom"><p>&copy; 2026 OurPath Guidance Ltd. All rights reserved.</p><p>London, UK</p></div>
  </div>
</footer>`

const SHARED_HEAD = `<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">`

const BLOG_INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
${SHARED_HEAD}
<title>Blog — Personal Development Reflections — OurPath Guidance</title>
<meta name="description" content="Reflections on personal development, reflective practice, and intentional growth.">
</head>
<body>
${SHARED_NAV}
<section class="page-hero">
  <div class="container"><div class="page-hero-content">
    <div class="section-label">Blog</div>
    <div class="hero-line"></div>
    <h1>Reflections on growth,<br>clarity, and <em>development.</em></h1>
    <p>Writing on personal development and reflective practice &#8212; the real questions beneath the surface of a managed life.</p>
  </div></div>
</section>
<section style="padding:5rem 0;background:var(--cream);">
  <div class="container">
    <div class="blog-grid">
      <!-- POSTS -->
    </div>
  </div>
</section>
<div class="cta-band">
  <div class="container">
    <div class="section-label" style="text-align:center;">Start Your Development</div>
    <h2>Want to start your development now?</h2>
    <p>Don&#8217;t wait for the blog. Start with a conversation.</p>
    <div class="cta-buttons">
      <a href="https://portal.ourpathguidance.co.uk/session-zero" class="btn-primary">Book a Free Conversation &#8594;</a>
      <a href="/mentoring" class="btn-secondary">Explore Mentoring</a>
    </div>
  </div>
</div>
${SHARED_FOOTER}
<script>
const reveals=document.querySelectorAll('.reveal');
const observer=new IntersectionObserver(e=>{e.forEach(t=>{if(t.isIntersecting)t.target.classList.add('visible')})},{threshold:.1,rootMargin:'0px 0px -50px 0px'});
reveals.forEach(el=>observer.observe(el));
window.addEventListener('scroll',()=>{document.getElementById('nav').classList.toggle('scrolled',window.scrollY>60);});
</script>
</body>
</html>`

const BLOG_POST_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
${SHARED_HEAD}
<title>{{TITLE}} — OurPath Guidance</title>
<meta name="description" content="{{EXCERPT}}">
</head>
<body>
${SHARED_NAV}
<article style="max-width:720px;margin:0 auto;padding:6rem 1.5rem 3rem;">
  <div style="margin-bottom:2rem;"><a href="/blog" style="color:var(--subtle);text-decoration:none;font-size:.9rem;">&#8592; All reflections</a></div>
  <div class="blog-date">{{DATE}}</div>
  <h1 style="font-size:2.5rem;line-height:1.15;margin:.5rem 0 1rem;">{{TITLE}}</h1>
  <p style="color:var(--subtle);font-style:italic;margin-bottom:2rem;">By {{AUTHOR}}</p>
  {{COVER}}
  <div class="post-body" style="font-size:1.05rem;line-height:1.75;">{{BODY}}</div>
  <div style="margin-top:2rem;">{{TAGS}}</div>
  <hr style="margin:3rem 0 2rem;border:0;border-top:1px solid rgba(0,0,0,0.08);"/>
  <div style="text-align:center;">
    <a href="https://portal.ourpathguidance.co.uk/session-zero" class="btn-primary">Book a Free Conversation &#8594;</a>
  </div>
</article>
${SHARED_FOOTER}
</body>
</html>`

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────
;(async () => {
  console.log('[build-blog] fetching posts from Notion…')
  const pages = await queryPublishedPosts()
  console.log(`[build-blog] found ${pages.length} published public posts`)

  const posts = []
  for (const page of pages) {
    const post = await mapPage(page)
    const blocks = await getPageBlocks(page.id)
    const body = await blocksToHtml(blocks)
    posts.push({ ...post, body })
  }

  // Write index
  fs.writeFileSync(path.join(ROOT, 'blog.html'), indexPage(posts))
  console.log('[build-blog] wrote blog.html')

  // Write per-post pages
  if (!fs.existsSync(POSTS_DIR)) fs.mkdirSync(POSTS_DIR, { recursive: true })
  for (const p of posts) {
    if (!p.slug) { console.warn(`[build-blog] skipping post without slug: "${p.title}"`); continue }
    const html = postPage(p, p.body)
    fs.writeFileSync(path.join(POSTS_DIR, `${p.slug}.html`), html)
    console.log(`[build-blog]   ${p.slug}.html`)
  }

  console.log(`[build-blog] done. ${posts.length} posts published.`)
})().catch(err => {
  console.error('[build-blog] FAILED:', err)
  process.exit(1)
})
