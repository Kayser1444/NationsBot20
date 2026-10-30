import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createQuestionModels, questionUsage, questionModels } from '../question-models.mjs';
import { createQuestionService } from '../question-service.mjs';
import { createQuestionLog } from '../question-log.mjs';
import { createOpenAiConnectionTest } from '../openai-connection-test.mjs';

const temp = t => { const directory = mkdtempSync(join(tmpdir(), 'nations-models-')); t.after(() => rmSync(directory, { recursive: true, force: true })); return directory; };
const env = { NATIONS_QUESTION_ENABLED: '1', OPENAI_API_KEY: 'synthetic-model-secret', NATIONS_OPENAI_ADMIN_KEY: 'never-use-admin-secret' };
const listed = () => Response.json({ data: [...questionModels.map(({ id }) => ({ id })), { id: 'text-embedding-3-small' }, { id: 'unknown-model' }] });
const owner = '229311536827465728';
test('model discovery uses the question key, filters compatible IDs, caches concurrent reads, and persists audited choices', async t => {
  const directory = temp(t), audit = []; let clock = Date.now(), calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const options = { directory, env, now: () => clock, report: message => audit.push(message), fetcher: async (url, options) => {
    calls++; assert.equal(url, 'https://api.openai.com/v1/models'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer '+env.OPENAI_API_KEY); await gate; return listed();
  } };
  let models = createQuestionModels(options); assert.equal(calls, 0); assert.equal(models.current(), 'gpt-6.1-sol');
  const first = models.catalogue(), second = models.catalogue(); assert.equal(calls, 1); release();
  assert.deepEqual(await first, await second); assert.equal((await first).models.length, 3);
  await assert.rejects(models.select('unknown-model', owner)); assert.equal(calls, 1);
  await models.select('gpt-6.1-terra', owner); assert.equal(calls, 1); assert.equal(models.current(), 'gpt-6.1-terra');
  assert.ok(audit.some(message => message.includes(owner) && message.includes('gpt-6.1-terra')));
  const saved = readFileSync(join(directory,'model.json'),'utf8'); assert.equal(saved.includes(env.OPENAI_API_KEY), false);
  models = createQuestionModels(options); assert.equal(models.current(), 'gpt-6.1-terra'); assert.equal(calls, 1);
  clock += 60001; await models.catalogue(); assert.equal(calls, 2);
});

test('unlisted models, missing keys and failed discovery never change selection or expose secrets; corrupt selection is repairable', async t => {
  for (const fetcher of [async () => Response.json({ data: [] }), async () => new Response('x'.repeat(1024*1024+1)),
    async () => { throw new Error(env.OPENAI_API_KEY); }, async () => Response.json({ error: { message: env.OPENAI_API_KEY } }, { status: 403 })]) {
    const directory = temp(t), models = createQuestionModels({ directory, env, fetcher });
    await assert.rejects(models.select('gpt-6.1-terra', owner)); assert.equal(models.current(), 'gpt-6.1-sol');
    assert.equal(existsSync(join(directory,'model.json')),false); assert.equal(JSON.stringify(await models.catalogue()).includes(env.OPENAI_API_KEY),false);
  }
  const missing = createQuestionModels({ directory: temp(t), env: { NATIONS_OPENAI_ADMIN_KEY: 'secret' }, fetcher: () => assert.fail() });
  assert.equal((await missing.catalogue()).available,false);
  const directory = temp(t); writeFileSync(join(directory,'model.json'),'{broken');
  const models = createQuestionModels({ directory, env, fetcher: async () => listed() });
  assert.throws(() => models.current()); assert.equal((await models.catalogue()).model,null);
  await models.select('gpt-6-luna',owner); assert.equal(models.current(),'gpt-6-luna');
});

const provider = (overrides = {}) => ({ service_tier: 'default', usage: { input_tokens: 12000, output_tokens: 100,
  input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 7000, cache_write_tokens_details: { ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 } },
  output_tokens_details: { reasoning_tokens: 50 } }, ...overrides });
test('cost estimates include cache reads/writes, do not double-count reasoning and refuse incomplete billing data', () => {
  const result = questionUsage(provider(),'gpt-6.1-terra');
  assert.equal(result.estimatedCostUsd,(1000+4000*.05+3000*1.25+4000*2.5+100*5)/1e6);
  assert.equal(result.reasoningTokens,50);
  assert.equal(questionUsage(provider(),'gpt-6.1-sol').estimatedCostUsd,result.estimatedCostUsd*2);
  for (const changed of [provider({ service_tier: 'priority' }), provider({ service_tier: undefined }), provider({ usage: { input_tokens: 12, output_tokens: 1 } }),
    provider({ usage: { input_tokens: 12, output_tokens: 1, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 5 } } }),
    provider({ usage: { input_tokens: 12, output_tokens: 1, input_tokens_details: { cached_tokens: 13, cache_write_tokens: 0 } } })]) {
    assert.equal(questionUsage(changed,'gpt-6.1-terra').estimatedCostUsd,undefined);
  }
});

test('one question keeps its chosen model during admin changes; the next question and restart use the new choice', async t => {
  const directory = temp(t); let clock = Date.now(), round = 0; const used = [], telemetry = [];
  const options = { directory, env, now: () => clock, fetcher: async (url, options) => {
    if (url === 'https://api.openai.com/v1/models') return listed();
    if (url !== 'https://api.openai.com/v1/responses') return new Response('', { status: 503 });
    const body = JSON.parse(options.body); used.push(body.model); assert.equal(body.service_tier,'default');
    const output = ++round % 2 ? [{ type: 'function_call', name: 'read_source', call_id: String(round), arguments: JSON.stringify({ id: 'code/dynasty_cards.py', start: 626, count: 42 }) }]
      : [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ question_language:'en',answer_language:'en',english_question:null,parts:[{text:'According to code/dynasty_cards.py:646, no.',english_text:null}] }) }] }];
    return Response.json({ status:'completed', model:body.model,...provider(),output });
  } };
  let service = createQuestionService(options); t.after(() => service.close());
  await service.selectModel('gpt-6.1-terra',owner);
  await service.ask({ userId:owner,question:'Can Poland sell this advisor?',onAccepted:()=>service.selectModel('gpt-6-luna',owner),onTelemetry:event=>telemetry.push(event) });
  assert.deepEqual(used,['gpt-6.1-terra','gpt-6.1-terra']); assert.ok(telemetry.some(e=>e.type==='configuration'&&e.model==='gpt-6.1-terra'&&e.promptHash));
  service.close(); service=createQuestionService(options); assert.equal(service.currentModel(),'gpt-6-luna'); clock+=60001;
  await service.ask({ userId:owner,question:'Can Poland sell this advisor?' }); assert.deepEqual(used.slice(-2),['gpt-6-luna','gpt-6-luna']);
  assert.equal(service.quota(owner).used,2); assert.equal(service.quota(owner).requests,4);
});

test('comparison records retain model, pricing and source context; missing usage never becomes a zero-cost run', () => {
  const log=createQuestionLog();
  const ids=[];
  for(const model of ['gpt-6.1-sol','gpt-6.1-terra']) {
    const id=log.start({ userId:owner,question:'Same question?',language:'en-US' });ids.push(id);
    log.telemetry(id,{type:'configuration',model,promptHash:'p',reasoningEffort:'low'});
    log.telemetry(id,{type:'retrieval',phase:'selected',name:'hybrid',corpusHash:model});
    log.telemetry(id,{type:'request',model});log.telemetry(id,{type:'api',model,status:200,durationMs:500,...questionUsage(provider(),model)});
    log.finish(id,{status:'answered',parts:[{text:model,delivery:'sent'}]});
  }
  const compared=log.comparisons(ids[0]);assert.equal(compared.records.length,2);
  assert.equal(compared.records[0].metrics.model,'gpt-6.1-terra'); assert.ok(compared.records[0].metrics.estimatedCostUsd>0);
  assert.notEqual(compared.records[0].metrics.corpusHash,compared.records[1].metrics.corpusHash);
  log.telemetry(ids[0],{type:'request',model:'gpt-6.1-sol'});log.telemetry(ids[0],{type:'api',status:200});
  assert.equal(log.read(ids[0]).metrics.estimatedCostUsd,null);
  log.start({userId:owner,question:'Different question?'});assert.equal(log.comparisons(ids[0]).records.length,2);
  assert.equal(log.comparisons('missing'),null);
});

test('connection test uses the saved model and never labels cached or in-flight results as a different model', async () => {
  let model='gpt-6.1-sol', clock=1000, calls=0,release;
  const gate=new Promise(resolve=>{release=resolve});
  const run=createOpenAiConnectionTest({env,now:()=>clock,getModel:()=>model,fetcher:async(_url,options)=>{
    calls++;const chosen=JSON.parse(options.body).model;await gate;return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'OK'}]}],model:chosen});
  }});
  const first=run();model='gpt-6.1-terra';assert.equal((await run()).code,'cooldown');release();assert.equal((await first).model,'gpt-6.1-sol');
  assert.equal((await run()).code,'cooldown'); assert.equal(calls,1);clock+=60000;assert.equal((await run()).model,'gpt-6.1-terra');assert.equal(calls,2);
});
