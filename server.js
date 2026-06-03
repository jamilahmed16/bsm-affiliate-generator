const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin:'*', methods:['POST','GET','OPTIONS'], allowedHeaders:['Content-Type','Authorization'] }));
app.use(express.json({ limit:'10mb' }));

app.get('/', (req, res) => {
  res.json({ status:'BSM Affiliate Article Generator running', version:'1.4.0' });
});

/* ================================================================
   STEP 1 — SERP ANALYSIS
   Brave Web Search → top 10 results for keyword
   Brave LLM Context → what competitors are covering
   Returns: intent, top URLs, content gaps, avg word count signal
   ================================================================ */

async function analyseSERP(keyword) {
  const braveKey = process.env.BRAVE_API_KEY;
  const serpKey  = process.env.SERP_API_KEY;

  let webResults = [];
  let lllmContext = '';
  let source = 'none';

  // ── Brave Web Search ──
  if (braveKey) {
    try {
      const r = await fetch(
        'https://api.search.brave.com/res/v1/web/search?q='
        + encodeURIComponent(keyword)
        + '&count=10&search_lang=en&country=us',
        { headers: { 'Accept':'application/json', 'Accept-Encoding':'gzip', 'X-Subscription-Token': braveKey } }
      );
      const d = await r.json();
      webResults = ((d.web && d.web.results) || []).slice(0, 10).map(function(item) {
        return {
          title:       item.title || '',
          url:         item.url   || '',
          description: item.description || '',
          age:         item.age   || ''
        };
      });
      source = 'Brave';
      console.log('SERP via Brave: ' + webResults.length + ' results for: ' + keyword);
    } catch(e) { console.log('Brave SERP failed: ' + e.message); }

    // ── Brave LLM Context endpoint ──
    try {
      const r2 = await fetch(
        'https://api.search.brave.com/res/v1/llm/context?q='
        + encodeURIComponent(keyword)
        + '&count=5',
        { headers: { 'Accept':'application/json', 'Accept-Encoding':'gzip', 'X-Subscription-Token': braveKey } }
      );
      const d2 = await r2.json();
      // LLM context returns structured content chunks
      if (d2.context && d2.context.length > 0) {
        lllmContext = d2.context.slice(0,5).map(function(c, i) {
          return 'Context ' + (i+1) + ': ' + (c.title||'') + '\n' + (c.content||c.description||'');
        }).join('\n\n');
      }
      console.log('Brave LLM Context: retrieved for: ' + keyword);
    } catch(e) { console.log('Brave LLM Context failed: ' + e.message); }
  }

  // ── SerpAPI fallback ──
  if (!webResults.length && serpKey) {
    try {
      const r = await fetch(
        'https://serpapi.com/search.json?engine=google&q='
        + encodeURIComponent(keyword)
        + '&num=10&gl=us&hl=en&api_key=' + serpKey
      );
      const d = await r.json();
      webResults = (d.organic_results||[]).slice(0,10).map(function(item) {
        return { title:item.title||'', url:item.link||'', description:item.snippet||'', age:item.date||'' };
      });

      // SerpAPI People Also Ask
      if (d.related_questions && d.related_questions.length > 0) {
        lllmContext += '\n\nPEOPLE ALSO ASK:\n' + d.related_questions.slice(0,5).map(function(q) {
          return '- ' + q.question + (q.answer ? '\n  Answer: ' + q.answer.slice(0,200) : '');
        }).join('\n');
      }

      // SerpAPI Related Searches
      if (d.related_searches && d.related_searches.length > 0) {
        lllmContext += '\n\nRELATED SEARCHES:\n' + d.related_searches.slice(0,8).map(function(s) {
          return '- ' + s.query;
        }).join('\n');
      }

      source = 'SerpAPI';
      console.log('SERP via SerpAPI: ' + webResults.length + ' results for: ' + keyword);
    } catch(e) { console.log('SerpAPI SERP failed: ' + e.message); }
  }

  // ── Classify search intent ──
  const kw = keyword.toLowerCase();
  let intent = 'informational';
  if (kw.match(/best|top|review|vs|compare|buy|cheap|price|deal|worth|recommend/)) intent = 'commercial';
  if (kw.match(/buy|purchase|order|shop|discount|coupon|sale/)) intent = 'transactional';
  if (kw.match(/how to|guide|tutorial|tips|ways|steps|beginners/)) intent = 'informational';

  // ── Identify content gaps from descriptions ──
  const allDescriptions = webResults.map(r => r.description).join(' ').toLowerCase();
  const possibleAngles = [
    { angle:'Price comparison table', present: allDescriptions.includes('price') || allDescriptions.includes('cost') },
    { angle:'Pros and cons list',     present: allDescriptions.includes('pros') || allDescriptions.includes('cons') },
    { angle:'Video embeds',           present: allDescriptions.includes('video') },
    { angle:'Size/fit guide',         present: allDescriptions.includes('size') || allDescriptions.includes('fit') },
    { angle:'Expert quotes',          present: allDescriptions.includes('expert') || allDescriptions.includes('according') },
    { angle:'FAQ schema section',     present: allDescriptions.includes('faq') || allDescriptions.includes('question') },
    { angle:'Buyer\'s guide section', present: allDescriptions.includes('guide') || allDescriptions.includes('how to choose') },
    { angle:'Amazon vs other retailers', present: allDescriptions.includes('amazon') },
  ];
  const gaps = possibleAngles.filter(a => !a.present).map(a => a.angle);

  return {
    keyword,
    intent,
    source,
    resultsCount: webResults.length,
    topResults: webResults,
    lllmContext,
    gaps,
    topTitles: webResults.slice(0,5).map(r => r.title),
    topURLs:   webResults.slice(0,5).map(r => r.url)
  };
}

/* ================================================================
   STEP 2 — AFFILIATE HTML BUILDER
   Outputs full BSM-styled affiliate article HTML
   Includes: comparison table, product cards, FAQ schema,
   affiliate CTA buttons, pros/cons, buyer's guide
   ================================================================ */

function escHtml(str) {
  return (str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function buildProductCard(product, index) {
  const badge = index === 0 ? '<div style="background:#E8FF00;color:#000;font-family:\'DM Mono\',monospace;font-size:9px;font-weight:700;letter-spacing:.2em;padding:4px 10px;text-transform:uppercase;display:inline-block;margin-bottom:10px;">⭐ Editor\'s Choice</div>' : '';
  const stars = '★'.repeat(Math.min(5, Math.max(3, 5 - index)));

  return '<div style="background:#111111;border:1px solid ' + (index===0?'#E8FF00':'#2E2E2E') + ';border-top:3px solid ' + (index===0?'#E8FF00':'#2E2E2E') + ';padding:24px;margin:20px 0;">'
    + badge
    + '<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:16px;">'
    + '<div style="flex:1;min-width:200px;">'
    + '<div style="font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:#E8FF00;margin-bottom:6px;">' + escHtml(product.brand) + '</div>'
    + '<div style="font-family:\'Barlow Condensed\',sans-serif;font-size:24px;font-weight:800;text-transform:uppercase;color:#FFFFFF;line-height:1;margin-bottom:8px;">' + escHtml(product.name) + '</div>'
    + '<div style="font-family:\'DM Mono\',monospace;font-size:11px;color:#FFD700;margin-bottom:8px;">' + stars + '</div>'
    + '<div style="font-family:\'Lora\',serif;font-size:15px;color:#C8C8C8;line-height:1.7;margin-bottom:12px;">' + escHtml(product.description) + '</div>'
    + '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">'
    + (product.pros||[]).slice(0,3).map(function(p) {
        return '<span style="font-family:\'DM Mono\',monospace;font-size:10px;background:#002200;color:#00cc66;padding:3px 8px;border:1px solid #004400;">✓ ' + escHtml(p) + '</span>';
      }).join('')
    + '</div>'
    + '</div>'
    + '<div style="text-align:center;flex-shrink:0;">'
    + '<div style="font-family:\'Barlow Condensed\',sans-serif;font-size:36px;font-weight:900;color:#FFFFFF;line-height:1;">' + escHtml(product.price) + '</div>'
    + '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:#555555;margin-bottom:12px;">' + escHtml(product.network||'via Impact.com') + '</div>'
    + '<a href="' + escHtml(product.affiliateUrl||'#') + '" style="display:block;background:#E8FF00;color:#000000;font-family:\'Barlow Condensed\',sans-serif;font-weight:700;font-size:16px;letter-spacing:.1em;text-transform:uppercase;padding:12px 24px;text-decoration:none;margin-bottom:6px;" target="_blank" rel="noopener sponsored">Buy Now &rarr;</a>'
    + '<div style="font-family:\'DM Mono\',monospace;font-size:8px;color:#444444;">*Affiliate link</div>'
    + '</div>'
    + '</div>'
    + '</div>';
}

function buildComparisonTable(products) {
  if (!products || products.length < 2) return '';
  const rows = products.map(function(p, i) {
    return '<tr style="background:' + (i%2===0?'#111111':'#0d0d0d') + ';">'
      + '<td style="padding:12px 16px;font-family:\'Barlow Condensed\',sans-serif;font-size:16px;font-weight:700;text-transform:uppercase;color:#FFFFFF;border-right:1px solid #2E2E2E;">'
      + (i===0?'<span style="color:#E8FF00;">⭐ </span>':'') + escHtml(p.brand) + ' ' + escHtml(p.name)
      + '</td>'
      + '<td style="padding:12px 16px;font-family:\'DM Mono\',monospace;font-size:13px;color:#E8FF00;font-weight:700;border-right:1px solid #2E2E2E;">' + escHtml(p.price) + '</td>'
      + '<td style="padding:12px 16px;font-family:\'DM Mono\',monospace;font-size:11px;color:#FFD700;">' + '★'.repeat(Math.min(5,Math.max(3,5-i))) + '</td>'
      + '<td style="padding:12px 16px;font-family:\'Lora\',serif;font-size:13px;color:#C8C8C8;">' + escHtml((p.pros||[])[0]||'') + '</td>'
      + '<td style="padding:12px 16px;text-align:center;">'
      + '<a href="' + escHtml(p.affiliateUrl||'#') + '" style="background:#E8FF00;color:#000;font-family:\'Barlow Condensed\',sans-serif;font-weight:700;font-size:13px;letter-spacing:.1em;text-transform:uppercase;padding:8px 16px;text-decoration:none;" target="_blank" rel="noopener sponsored">Buy &rarr;</a>'
      + '</td>'
      + '</tr>';
  }).join('');

  return '<div style="margin:36px 0;max-width:100%;overflow-x:auto;">'
    + '<div style="font-family:\'Barlow Condensed\',sans-serif;font-size:22px;font-weight:800;text-transform:uppercase;color:#FFFFFF;padding:16px 20px;background:#1A1A1A;border-top:3px solid #E8FF00;border:1px solid #2E2E2E;border-bottom:none;">Quick Comparison</div>'
    + '<table style="width:100%;border-collapse:collapse;border:1px solid #2E2E2E;">'
    + '<thead><tr style="background:#1A1A1A;">'
    + '<th style="padding:12px 16px;font-family:\'DM Mono\',monospace;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#E8FF00;text-align:left;border-right:1px solid #2E2E2E;">Product</th>'
    + '<th style="padding:12px 16px;font-family:\'DM Mono\',monospace;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#E8FF00;text-align:left;border-right:1px solid #2E2E2E;">Price</th>'
    + '<th style="padding:12px 16px;font-family:\'DM Mono\',monospace;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#E8FF00;text-align:left;border-right:1px solid #2E2E2E;">Rating</th>'
    + '<th style="padding:12px 16px;font-family:\'DM Mono\',monospace;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#E8FF00;text-align:left;border-right:1px solid #2E2E2E;">Best For</th>'
    + '<th style="padding:12px 16px;font-family:\'DM Mono\',monospace;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#E8FF00;text-align:center;">Buy</th>'
    + '</tr></thead>'
    + '<tbody>' + rows + '</tbody>'
    + '</table>'
    + '</div>';
}

function buildFaqHtml(faqItems) {
  if (!faqItems || !faqItems.length) return '';
  var showItems = faqItems.slice(0, 6);
  var itemsHtml = showItems.map(function(item) {
    return '<div itemscope itemprop="mainEntity" itemtype="https://schema.org/Question" style="border-bottom:1px solid #2E2E2E;">'
      + '<div style="padding:16px 20px;background:#111111;">'
      + '<strong style="font-family:'Barlow Condensed',sans-serif;font-size:17px;font-weight:700;text-transform:uppercase;color:#E8FF00;display:block;margin-bottom:10px;" itemprop="name">' + escHtml(item.q) + '</strong>'
      + '<div itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer">'
      + '<div itemprop="text" style="font-family:'Lora',serif;font-size:15px;color:#C8C8C8;line-height:1.75;">' + escHtml(item.a) + '</div>'
      + '</div></div></div>';
  }).join('');

  // JSON-LD FAQPage schema — Google rich results + AI search engines
  var schemaData = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    'mainEntity': showItems.map(function(item) {
      return {
        '@type': 'Question',
        'name': item.q,
        'acceptedAnswer': { '@type': 'Answer', 'text': item.a }
      };
    })
  };
  var jsonLd = '<script type="application/ld+json">' + JSON.stringify(schemaData) + '<\/script>';

  // Speakable schema — voice search, Google Assistant, AI answer engines
  var speakableData = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    'speakable': { '@type': 'SpeakableSpecification', 'cssSelector': ['.bsm-faq-wrap'] }
  };
  var speakable = '<script type="application/ld+json">' + JSON.stringify(speakableData) + '<\/script>';

  return '\n' + jsonLd + speakable
    + '<div class="bsm-faq-wrap" itemscope itemtype="https://schema.org/FAQPage" style="max-width:720px;margin:40px 0;border:1px solid #2E2E2E;overflow:hidden;">'
    + '<div style="font-family:'Barlow Condensed',sans-serif;font-size:22px;font-weight:800;text-transform:uppercase;color:#FFFFFF;padding:16px 20px;background:#1A1A1A;border-bottom:2px solid #E8FF00;">Frequently Asked Questions</div>'
    + itemsHtml + '</div>\n';
}

function buildAffiliateHtml(parsed) {
  const { sections, faq, products } = parsed;
  let body = '';

  // Comparison table first (high converting)
  if (products && products.length > 1) {
    body += buildComparisonTable(products);
  }

  sections.forEach(function(s, i) {
    if (i === 0) {
      body += s.paragraphs.map(p => '<p style="font-family:\'Lora\',serif;font-size:17px;line-height:1.85;color:#C8C8C8;margin-bottom:22px;">' + p + '</p>').join('\n');

      // Mid-article ad
      body += '\n<div style="background:#111111;border:1px dashed #2E2E2E;text-align:center;font-family:monospace;font-size:9px;color:#444;text-transform:uppercase;min-height:90px;line-height:90px;margin:32px 0;"><!-- ADSENSE: paste here --> Advertisement</div>\n';

      // Product cards after intro
      if (products && products.length > 0) {
        body += '\n<h2 style="font-family:\'Barlow Condensed\',sans-serif;font-size:32px;font-weight:800;text-transform:uppercase;color:#FFFFFF;line-height:1;margin:40px 0 16px;padding-left:14px;border-left:3px solid #E8FF00;">Our Top Picks</h2>\n';
        products.forEach(function(p, pi) { body += buildProductCard(p, pi); });
      }

    } else {
      body += '\n<h2 style="font-family:\'Barlow Condensed\',sans-serif;font-size:32px;font-weight:800;text-transform:uppercase;color:#FFFFFF;line-height:1;margin:40px 0 16px;padding-left:14px;border-left:3px solid #E8FF00;">' + escHtml(s.heading) + '</h2>\n';
      body += s.paragraphs.map(p => '<p style="font-family:\'Lora\',serif;font-size:17px;line-height:1.85;color:#C8C8C8;margin-bottom:22px;">' + p + '</p>').join('\n');
    }
  });

  // Affiliate disclosure
  const disclosure = '<div style="background:#1A1A1A;border:1px solid #2E2E2E;border-left:3px solid #555;padding:16px 20px;margin:32px 0;font-family:\'DM Mono\',monospace;font-size:10px;color:#555555;line-height:1.7;">'
    + '<strong style="color:#888888;">AFFILIATE DISCLOSURE:</strong> BestSportsMag earns a commission from qualifying purchases made through links on this page via Amazon Associates and Impact.com partner programs. This comes at no extra cost to you and helps us keep the lights on.'
    + '</div>';

  body = disclosure + body;

  return '<!-- BSM Affiliate Content v1.0 -->\n<div class="bsm-affiliate-content">\n'
    + body + '\n'
    + buildFaqHtml(faq)
    + '\n</div>';
}

/* ================================================================
   STEP 3 — ARTICLE PARSER
   Extracts: title, slug, meta, sections, FAQ, products
   ================================================================ */
function parseAffiliateArticle(rawText) {
  const result = { title:'', slug:'', meta:'', sections:[], faq:[], products:[] };

  const tM = rawText.match(/TITLE:\s*(.+?)(?:\n|$)/);
  const sM = rawText.match(/SLUG:\s*(.+?)(?:\n|$)/);
  const mM = rawText.match(/META:\s*(.+?)(?:\n|$)/);
  result.title = tM ? tM[1].trim() : '';
  result.slug  = sM ? sM[1].trim().replace(/[^a-z0-9-]/g,'') : '';
  result.meta  = mM ? mM[1].trim() : '';

  const cM = rawText.match(/CONTENT:\s*([\s\S]+)/);
  const content = cM ? cM[1].trim() : rawText;

  // Extract FAQ
  const faqBM = content.match(/##\s*(?:Frequently Asked Questions|FAQ)\s*([\s\S]+?)(?=\n##\s|$)/i);
  if (faqBM) {
    const chunks = faqBM[1].split(/\*\*Q:\*\*/i).filter(s=>s.trim());
    chunks.forEach(function(chunk) {
      const aIdx = chunk.search(/\*\*A:\*\*/i);
      if (aIdx === -1) return;
      let q = chunk.slice(0,aIdx).replace(/\*\*/g,'').replace(/^[:\s]+/,'').trim();
      let a = chunk.slice(aIdx).replace(/^\*\*A:\*\*/i,'').replace(/\*\*Q:[\s\S]*/i,'').replace(/\*\*/g,'').trim().replace(/\n/g,' ').replace(/\s+/g,' ');
      if (q && a && q.length > 3) result.faq.push({q, a});
    });
  }

  // Extract products from PRODUCTS: block
  const prodBM = rawText.match(/PRODUCTS:\s*([\s\S]+?)(?=\nCONTENT:|$)/i);
  if (prodBM) {
    const prodLines = prodBM[1].split('\n').filter(l=>l.trim().startsWith('-'));
    prodLines.forEach(function(line, i) {
      // Format: - Brand | Name | Price | Pros: x, y | Network
      const parts = line.replace(/^-\s*/,'').split('|').map(p=>p.trim());
      if (parts.length >= 3) {
        const prosMatch = (parts[3]||'').replace(/^Pros?:\s*/i,'');
        result.products.push({
          brand:       parts[0] || 'Brand',
          name:        parts[1] || 'Product',
          price:       parts[2] || '$0',
          pros:        prosMatch ? prosMatch.split(',').map(p=>p.trim()) : [],
          description: parts[4] || '',
          network:     parts[5] || 'via Impact.com',
          affiliateUrl:'#'
        });
      }
    });
  }

  // Remove FAQ from content
  const noFaq = content.replace(/##\s*(?:Frequently Asked Questions|FAQ)[\s\S]+?(?=\n##\s|$)/i,'');

  // Sections
  noFaq.split(/^## /m).forEach(function(part, i) {
    if (!part.trim()) return;
    let heading='', text=part;
    if (i > 0) {
      const nl = part.indexOf('\n');
      if (nl > -1) { heading=part.slice(0,nl).trim(); text=part.slice(nl+1); }
      else { heading=part.trim(); text=''; }
    }
    text = text
      .replace(/\[AFFILIATE:[^\]]+\]/gi,'').replace(/\[AMAZON:[^\]]+\]/gi,'')
      .replace(/\[INTERNAL:\s*([^\]]+)\]/gi,'<a href="#" style="color:#E8FF00;text-decoration:underline;">$1</a>')
      .replace(/\*\*(.+?)\*\*/g,'<strong style="color:#FFFFFF;font-weight:600;">$1</strong>')
      .replace(/\*(.+?)\*/g,'<em>$1</em>');
    const paragraphs = text.split(/\n\n+/).map(p=>p.trim()).filter(p=>p&&!p.startsWith('#')&&p.length>20).map(p=>p.replace(/\n/g,' '));
    if (paragraphs.length > 0 || heading) result.sections.push({heading, paragraphs});
  });

  return result;
}

/* ================================================================
   ENDPOINT 1 — /analyse
   Returns SERP analysis for a keyword
   Used by the frontend to show competitor data before generating
   ================================================================ */
app.post('/analyse', async (req, res) => {
  try {
    const { keyword } = req.body;
    if (!keyword) return res.status(400).json({ error:'Missing keyword' });
    const analysis = await analyseSERP(keyword);
    res.json(analysis);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================================================================
   ENDPOINT 2 — /generate
   Full pipeline: SERP → Claude affiliate article → BSM HTML
   ================================================================ */
app.post('/generate', async (req, res) => {
  try {
    const { keyword, articleType, wordCount, affiliateNetwork, targetAudience, brands } = req.body;
    if (!keyword) return res.status(400).json({ error:'Missing keyword' });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error:'API key not set' });

    // ── Parallel API calls — SERP + Shopping + News + PAA ──
    console.log('Running all API lookups for: ' + keyword);
    const [serp, shopping, news, paa, trends, videos, aiOverview, amazon] = await Promise.all([
      analyseSERP(keyword),
      getShoppingData(keyword),
      getNewsData(keyword),
      getPAAData(keyword),
      getTrendsData(keyword),
      getVideosData(keyword),
      getAIOverview(keyword),
      getAmazonData(keyword)
    ]);
    console.log('All APIs done — SERP:' + serp.resultsCount
      + ' Shopping:' + shopping.products.length
      + ' Amazon:' + amazon.products.length
      + ' News:' + news.news.length
      + ' PAA:' + paa.questions.length
      + ' Trends:' + trends.trends.length
      + ' Videos:' + videos.videos.length
      + ' AIOverview:' + (aiOverview.overview ? 'yes' : 'no'));

    // ── Trends context ──
    const trendsCtx = trends.relatedQueries.length > 0
      ? '\n\nGOOGLE TRENDS RISING QUERIES (use these as LSI keywords and H2 topics):\n'
        + trends.relatedQueries.join(', ')
        + (trends.trends.length > 0
            ? '\nTrend direction: ' + (trends.trends[trends.trends.length-1].value > trends.trends[0].value ? '📈 Rising' : '📉 Declining')
            : '')
      : '';

    // ── Videos context — embed suggestions ──
    const videosCtx = videos.videos.length > 0
      ? '\n\nRELEVANT YOUTUBE VIDEOS TO REFERENCE (mention these in the article as supporting resources):\n'
        + videos.videos.map(function(v, i) {
            return (i+1) + '. "' + v.title + '" by ' + v.channel
              + (v.views ? ' — ' + v.views + ' views' : '')
              + '\n   Embed: ' + v.link;
          }).join('\n')
      : '';

    // ── AI Overview context — understand what AI says, write better ──
    const aiCtx = (aiOverview.overview || aiOverview.featuredSnippet)
      ? '\n\nGOOGLE AI OVERVIEW / FEATURED SNIPPET (your article must be more comprehensive than this):\n'
        + (aiOverview.featuredSnippet ? 'Featured Snippet: ' + aiOverview.featuredSnippet + '\n' : '')
        + (aiOverview.overview ? 'AI Overview: ' + aiOverview.overview : '')
        + '\nIMPORTANT: Your article must directly answer this in the opening and provide significantly more depth.'
      : '';

    // ── Amazon context — real Amazon prices and bestsellers ──
    const amazonCtx = amazon.products.length > 0
      ? '\n\nAMAZON BESTSELLERS WITH REAL PRICES (use for Amazon Associates links and price data):\n'
        + amazon.products.map(function(p, i) {
            return (i+1) + '. ' + p.title
              + (p.price ? ' — ' + p.price : '')
              + (p.rating ? ' — ' + p.rating + '★' : '')
              + (p.reviews ? ' (' + p.reviews + ' reviews)' : '')
              + (p.prime ? ' [Prime]' : '')
              + (p.badge ? ' [' + p.badge + ']' : '');
          }).join('\n')
        + '\nUse these for Amazon Associates [AMAZON: Product — Price] placeholders.'
      : '';

    // ── Build SEO-informed prompt ──
    const typeMap = {
      'best-list':   'a "Best [Product]" roundup article ranking and reviewing 5-7 specific products with pros, cons, and buy links',
      'review':      'a detailed single-product review covering specs, real-world performance, pros, cons, verdict, and who should buy',
      'comparison':  'a head-to-head comparison of 2-3 specific products with a clear winner recommendation',
      'buyers-guide':'a comprehensive buyer\'s guide helping readers choose the right product for their needs',
      'deals':       'a deals and discounts article highlighting best current prices and where to buy'
    };

    const serpContext = serp.topResults.length > 0
      ? 'CURRENT TOP 10 RANKING PAGES (analyse these to find gaps and write better content):\n\n'
        + serp.topResults.map((r,i) => (i+1)+'. '+r.title+'\nURL: '+r.url+'\nSnippet: '+r.description).join('\n\n')
      : '';

    const lllmCtx = serp.lllmContext
      ? '\n\nCURRENT CONTENT CONTEXT (what competitors are covering):\n' + serp.lllmContext
      : '';

    const gapsCtx = serp.gaps.length > 0
      ? '\n\nCONTENT GAPS (what competitors are MISSING — include all of these):\n' + serp.gaps.map(g=>'- '+g).join('\n')
      : '';

    const brandsCtx = brands ? '\nFEATURED BRANDS: ' + brands : '\nFEATURED BRANDS: Adidas, Nike, Puma, Oakley';

    // ── Shopping context — real live prices ──
    const shoppingCtx = shopping.products.length > 0
      ? '\n\nLIVE PRODUCT PRICES FROM GOOGLE SHOPPING (use these EXACT prices in your article):\n'
        + shopping.products.map(function(p, i) {
            return (i+1) + '. ' + p.title
              + (p.price ? ' — ' + p.price : '')
              + (p.source ? ' — via ' + p.source : '')
              + (p.rating ? ' — ' + p.rating + '★' : '')
              + (p.reviews ? ' (' + p.reviews + ' reviews)' : '');
          }).join('\n')
        + '\nIMPORTANT: Use these real prices. Do not invent prices.'
      : '';

    // ── News context — breaking hook ──
    const newsCtx = news.news.length > 0
      ? '\n\nLATEST NEWS HOOK (reference 1-2 of these in your opening to make the article timely):\n'
        + news.news.map(function(n, i) {
            return (i+1) + '. ' + n.title
              + (n.source ? ' — ' + n.source : '')
              + (n.date ? ' — ' + n.date : '');
          }).join('\n')
      : '';

    // ── PAA context — real questions people search ──
    const paaCtx = paa.questions.length > 0
      ? '\n\nPEOPLE ALSO ASK — REAL GOOGLE QUESTIONS (use these as your FAQ questions EXACTLY as written):\n'
        + paa.questions.map(function(q, i) {
            return (i+1) + '. Q: ' + q.question
              + (q.answer ? '\n   Existing answer hint: ' + q.answer.slice(0,200) : '');
          }).join('\n')
        + '\n\nRELATED SEARCHES (use as LSI keywords naturally in body text):\n'
        + (paa.relatedSearches || []).join(', ')
      : '';

    const systemPrompt = 'You are an expert sports affiliate content writer for BestSportsMag.com. '
      + 'You write SEO-optimised affiliate articles that rank on Google AND convert readers into buyers. '
      + 'Search intent for this keyword is: ' + serp.intent + '. '
      + 'You must analyse competitor content gaps and write something genuinely better. '
      + 'Always include specific product names, real prices (estimate if unknown), and genuine buying advice. '
      + 'Never use vague filler — every sentence must help the reader make a purchase decision. '
      + 'Current date: ' + new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});

    const wc = parseInt(wordCount) || 2000;
    const numSects = wc <= 1500 ? 5 : wc <= 2000 ? 7 : wc <= 2500 ? 9 : 11;

    // ── Extract product count from keyword e.g. '15 Best Football Boots' → 15 ──
    const numMatch = keyword.match(/^(\d+)\s+/);  
    const productCount = numMatch ? parseInt(numMatch[1]) : (articleType === 'best-list' ? 5 : 3);
    const cleanKeyword = numMatch ? keyword.replace(/^\d+\s+/,'').trim() : keyword;

    const userPrompt = 'Write a COMPLETE, LONG-FORM ' + wc + '-word SEO affiliate article. '
      + 'CRITICAL: You must write at least ' + wc + ' words. Every section needs 3-5 full paragraphs (100+ words each). Do not truncate or summarise.\n\n'
      + 'TARGET KEYWORD: "' + keyword + '"\n'
      + 'ARTICLE TYPE: ' + (typeMap[articleType] || typeMap['best-list']) + '\n'
      + 'NUMBER OF PRODUCTS TO INCLUDE: ' + productCount + ' — YOU MUST LIST EXACTLY ' + productCount + ' PRODUCTS. Not more, not less.\n'
      + 'AFFILIATE NETWORK: ' + (affiliateNetwork||'Amazon Associates + Impact.com') + '\n'
      + 'TARGET AUDIENCE: ' + (targetAudience||'global sports fans') + '\n'
      + brandsCtx + '\n\n'
      + serpContext + lllmCtx + gapsCtx
      + shoppingCtx + amazonCtx + newsCtx
      + paaCtx + trendsCtx + videosCtx + aiCtx + '\n\n'
      + 'OUTPUT FORMAT — follow exactly:\n\n'
      + 'TITLE: [Under 60 chars — use the exact keyword including the number if present, e.g. 15 Best Football Boots 2026]\n\n'
      + 'SLUG: [Lowercase hyphens only, max 7 words, include number if present]\n\n'
      + 'META: [Exactly 150-155 chars, keyword + specific benefit + soft CTA]\n\n'
      + 'PRODUCTS:\n'
      + '- Brand | Full Product Name with Model |  | Pros: pro1, pro2, pro3 | 20-word description | Network\n'
      + '[YOU MUST LIST EXACTLY ' + productCount + ' products here with real specific model names and prices. No more, no less.]\n\n'
      + 'CONTENT:\n'
      + '[OPENING — 3 full paragraphs: hook, why this keyword matters in 2026, what article covers, price range anchor]\n\n'
      + '## Why These Are The ' + productCount + ' Best ' + cleanKeyword + '\n'
      + '[3 paragraphs — our testing methodology, criteria used to select these ' + productCount + ' picks, what separates them from the rest]\n\n'
      + '## Quick Comparison: All ' + productCount + ' Picks at a Glance\n'
      + '[2 paragraphs — brief overview comparing all ' + productCount + ' products before deep reviews, price range summary]\n\n'
      + '## In-Depth Reviews: All ' + productCount + ' Picks\n'
      + '[CRITICAL: Write a dedicated subsection for EACH of the ' + productCount + ' products. For every single product write: ### [Rank]. [Brand] [Model] — then 3 full paragraphs covering performance, specs, who it suits, real-world use, pros and cons.]\n\n'
      + '## What to Look For When Buying ' + cleanKeyword + '\n'
      + '[4 paragraphs: budget tiers, key specs to check, surface/use case guide, fit and sizing, what to avoid]\n\n'
      + '## Best Budget Pick vs Best Premium Pick\n'
      + '[3 paragraphs: budget recommendation with full reasoning, premium recommendation with full reasoning, who should choose each]\n\n'
      + '## Where to Buy for the Best Price\n'
      + '[2 paragraphs: Amazon vs Impact.com, shipping, returns, authenticity, timing for deals]\n\n'
      + '## Common Mistakes to Avoid When Buying ' + cleanKeyword + '\n'
      + '[3 paragraphs: top 5 mistakes buyers make, how to avoid each, specific cautionary examples]\n\n'
      + (numSects >= 9 ? '## Expert Tips to Get the Most From Your Purchase\n[3 paragraphs: actionable expert advice on maintenance, performance optimisation, when to upgrade]\n\n' : '')
      + '## Final Verdict: Our Top ' + productCount + ' Recommendations\n'
      + '[3 paragraphs: summarise findings, name overall winner + runner-up + budget pick, strong call to action]\n\n'
      + '## Frequently Asked Questions\n'
      + 'YOU MUST WRITE EXACTLY 6 FAQ ITEMS. Use the PEOPLE ALSO ASK questions from the data above as your FAQ questions — they are real Google searches. Each answer must be 3-4 sentences minimum.\n\n'
      + '**Q:** What is the best ' + cleanKeyword + ' overall in 2026?\n'
      + '**A:** [3-4 sentence answer naming the #1 pick, its price, key reason it wins, who it suits best]\n\n'
      + '**Q:** What is the best budget ' + cleanKeyword + ' for the money?\n'
      + '**A:** [3-4 sentence answer naming the best value pick, price, what you sacrifice vs premium, who it is for]\n\n'
      + '**Q:** [Most searched People Also Ask question about ' + cleanKeyword + ']?\n'
      + '**A:** [3-4 sentence direct answer with specific product names, prices, or data points]\n\n'
      + '**Q:** Is ' + cleanKeyword + ' worth the money in 2026?\n'
      + '**A:** [3-4 sentence honest verdict explaining value proposition, what you get at each price point]\n\n'
      + '**Q:** [Fifth common buyer question about ' + cleanKeyword + ' — e.g. How long do they last? What size should I get?]?\n'
      + '**A:** [3-4 sentence direct answer with specific practical advice]\n\n'
      + '**Q:** [Sixth common buyer question — e.g. What is the difference between X and Y? Can beginners use them?]?\n'
      + '**A:** [3-4 sentence direct answer with specific practical advice and a product recommendation]\n\n'
      + 'WRITING RULES — NON-NEGOTIABLE:\n'
      + '- WORD COUNT: minimum ' + wc + ' words. Every section fully written. No truncating.\n'
      + '- PRODUCT COUNT: exactly ' + productCount + ' products in the PRODUCTS block AND in the reviews section. Count them.\n'
      + '- FAQ COUNT: exactly 6 FAQ items with **Q:** and **A:** format. Each answer 3-4 sentences minimum.\n'
      + '- Every H2 section: minimum 3 paragraphs of 100+ words each.\n'
      + '- Every product review: minimum 3 paragraphs with ### heading showing rank and model name.\n'
      + '- Specific product model names and prices throughout — never generic.\n'
      + '- Target keyword in: title, first 100 words, 3+ H2 headings, final verdict.\n'
      + '- Price anchor in opening paragraph.\n'
      + '- 2-3 internal links: [INTERNAL: related article topic]\n'
      + '- 2-3 affiliate placeholders: [AFFILIATE: Product Name —  — Brand — Network]\n'
      + '- End with strong conversion paragraph.';

    // ── Call Claude ──
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':apiKey, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{ role:'user', content:userPrompt }]
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error ? data.error.message : 'API error' });

    const rawText = data.content[0].text;
    const parsed  = parseAffiliateArticle(rawText);
    const html    = buildAffiliateHtml(parsed);

    res.json({
      content: [{ type:'text', text:rawText }],
      bsm: {
        title:         parsed.title,
        slug:          parsed.slug,
        meta:          parsed.meta,
        html:          html,
        raw:           rawText,
        products:      parsed.products,
        faqCount:      parsed.faq.length,
        sectionCount:  parsed.sections.length,
        dataEnrichment: {
          shoppingProducts: shopping.products.length,
          amazonProducts:   amazon.products.length,
          newsStories:      news.news.length,
          paaQuestions:     paa.questions.length,
          trendingQueries:  trends.relatedQueries.length,
          videosFound:      videos.videos.length,
          aiOverviewFound:  !!(aiOverview.overview || aiOverview.featuredSnippet),
          sources: {
            shopping: shopping.source,
            amazon:   amazon.source,
            news:     news.source,
            paa:      paa.source,
            trends:   trends.source,
            videos:   videos.source,
            aiMode:   aiOverview.source
          }
        },
        serp: {
          intent:       serp.intent,
          source:       serp.source,
          resultsCount: serp.resultsCount,
          topTitles:    serp.topTitles,
          gaps:         serp.gaps
        }
      }
    });

  } catch(error) {
    console.error('Affiliate generator error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => console.log('BSM Affiliate Generator v1.0 running on port ' + PORT));
