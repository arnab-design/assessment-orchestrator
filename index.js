require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function crawl(url) {
  const res = await axios.post(process.env.CRAWL4AI_ENDPOINT, {
    url,
    maxPages: 20,
    depth: 2,
    crawlJs: true,
    htmlOnly: false
  });
  return res.data.pages.map(p => `## ${p.title} (${p.url})\n${p.text}`).join('\n\n');
}

async function run() {
  const { data: triggers } = await supabase
    .from('CompanyAssessmentTrigger')
    .select('*')
    .eq('status', 'queued')
    .limit(1);

  if (!triggers || triggers.length === 0) return;

  const trigger = triggers[0];

  const investorText = await crawl(trigger.investor_site);
  const companyText = await crawl(trigger.company_url);

  const formattedPrompt = `
Investor Profile Input:
- PE/VC Firm Name: ${trigger.investor_name}
- Website: ${trigger.investor_site}
- Supplemental Links: ${JSON.stringify(trigger.supplemental_links)}

Target Company Input:
- Company Name: ${trigger.company_name}
- Website: ${trigger.company_url}
- Assessment Context: ${trigger.context}

Extracted Content:
## Investor Pages
${investorText}

## Company Pages
${companyText}
`;

  const thread = await openai.beta.threads.create();
  await openai.beta.threads.messages.create(thread.id, {
    role: "user",
    content: formattedPrompt
  });

  const run = await openai.beta.threads.runs.create(thread.id, {
    assistant_id: process.env.ASSISTANT_ID
  });

  while (true) {
    const status = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    if (status.status === 'completed') break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  const messages = await openai.beta.threads.messages.list(thread.id);
  const result = messages.data[0].content[0].text.value;

  await supabase.from('CompanyAssessments').insert([{
    investor_name: trigger.investor_name,
    investor_site: trigger.investor_site,
    company_name: trigger.company_name,
    company_url: trigger.company_url,
    context: trigger.context,
    report_json: result
  }]);

  await supabase.from('CompanyAssessmentTrigger')
    .update({ status: 'complete' })
    .eq('id', trigger.id);

  await supabase.from('AuditLogs').insert([{
    action: 'Assessment Complete',
    source_url: trigger.company_url,
    confidence_score: 90,
    details: 'Report stored',
  }]);
}

// Poll every 10 seconds
setInterval(run, 10000);
