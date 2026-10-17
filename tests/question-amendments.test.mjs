import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { faqAmendments, faqAmendmentsUrl, faqAmendmentTranslations, amendmentTranslation } from '../question-amendments.mjs';
import { text } from '../language.mjs';
import { createQuestionCorpus } from '../question-sources.mjs';
import { investigateQuestion } from '../question-agent.mjs';
import { rulesDifferencesUrl } from '../question-errata.mjs';
import { questionReplyParts, questionSourceFooter } from '../question-answer.mjs';
import { cardBank } from '../card-bank.mjs';
const read = path => JSON.parse(readFileSync(new URL('../data/' + path, import.meta.url), 'utf8'));
const snapshot = read('question/tabony-snapshot.json');
const corpus = () => createQuestionCorpus(snapshot, read('faq/entries.json'), [], null, read('question/tabony-rules-differences.json'));
const pages = (name, language = 'en-US', nation = false) => {
  const render = page => nation ? cardBank.renderNation(name, language, {faqPage:page}) : cardBank.render(name, language, {faqPage:page});
  return Array.from({length:render(0).faqPageCount}, (_, page) => render(page));
};
const body = replies => replies.flatMap(reply => reply.messages.flatMap(message => message.embeds.map(embed => embed.description ?? ''))).join('\n');

test('all 28 amendments are locally readable, searchable and attributed independently', () => {
  const c = corpus();
  assert.equal(faqAmendments.entries.length, 28);
  assert.match(faqAmendments.provenance, /Rustan and Robert/);
  for (const entry of faqAmendments.entries) {
    const source = c.read({id:`faq-amendments/${entry.id}`});
    assert.equal(source.kind, 'faq-amendment');
    assert.equal(source.url, faqAmendments.url);
    assert.match(source.provenance, /editorial summaries/);
    assert.ok(source.excerpt.includes(entry.text));
  }
  assert.ok(c.search({query:'private architects'}).some(hit => hit.id === 'faq-amendments/private-architects'));
  assert.match(c.read({id:'faq-amendments/great-exhibition'}).excerpt, /may choose to hire just one/);
  const catalog = read('cards/catalog.json');
  const names = new Set(catalog.cards.flatMap(card => [card.name, ...card.aliases]).map(name=>name.toLowerCase()));
  for (const entry of faqAmendments.entries) for (const name of entry.names) assert.ok(names.has(name.toLowerCase()), name);
});

test('cards and nations retain separate amendment citations through pagination and button navigation', () => {
  for (const language of ['en-US','sv-SE','de','fr','es-ES','zh-CN']) {
    const poland = body(pages('Poland',language,true));
    assert.match(poland,/Inofficial FAQ amendments/);
    assert.ok(poland.includes(amendmentTranslation(faqAmendments.entries.find(entry=>entry.id==='poland'),language).text));
    assert.ok(poland.includes(faqAmendments.url));
    assert.ok(body(pages('Galileo Galilei',language)).includes(amendmentTranslation(faqAmendments.entries.find(entry=>entry.id==='axumite'),language).text));
    assert.match(body(pages('Frederic Chopin',language)),/Coffee House/);
    assert.ok(body(pages('Archimedes',language)).includes(amendmentTranslation(faqAmendments.entries[0],language).text));
    assert.doesNotMatch(body(pages('Porcelain Tower',language)),/Inofficial FAQ amendments/);
    for (const reply of pages('Poland',language,true)) {
      const message = reply.messages[0];
      assert.deepEqual(message.allowed_mentions,{parse:[],users:[],roles:[]});
      assert.ok(message.embeds.every(embed => (embed.description?.length ?? 0) <= 4096));
      const size = message.embeds.reduce((sum,embed)=>sum+(embed.title?.length??0)+(embed.description?.length??0),0);
      assert.ok(size <= 6000);
      const id = message.components[0].components[0].custom_id;
      assert.equal(cardBank.renderButton(id).ok,true);
    }
  }
});

test('all amendments have source-bound translations with preserved numbers and short notices', () => {
  assert.equal(faqAmendmentTranslations.entries.length,faqAmendments.entries.length);
  assert.equal(new Set(faqAmendmentTranslations.entries.map(entry=>entry.id)).size,28);
  for (const entry of faqAmendments.entries) for (const language of ['sv-SE','de','fr','es-ES','zh-CN']) {
    const translated = amendmentTranslation(entry,language);
    assert.ok(translated?.text && translated.heading,entry.id+' '+language);
    assert.notEqual(translated.text,entry.text);
    assert.deepEqual(translated.text.match(/\d+/g)??[],entry.text.match(/\d+/g)??[],entry.id+' '+language);
    assert.equal(amendmentTranslation({...entry,text:entry.text+' Edited.'},language),null);
    assert.equal(amendmentTranslation({...entry,heading:entry.heading+' Edited'},language),null);
  }
  for (const language of ['en-US','sv-SE','de','fr','es-ES','zh-CN']) {
    const arab=body(pages('Arabs',language,true));
    const viking=body(pages('Vikings',language,true));
    assert.ok(arab.includes(amendmentTranslation(faqAmendments.entries.find(entry=>entry.id==='arabs-assassin'),language).text));
    assert.ok(viking.includes(amendmentTranslation(faqAmendments.entries.find(entry=>entry.id==='vikings-athens'),language).text));
    assert.ok(!arab.includes(text(language,'cardAmendmentsSummary')));
    assert.doesNotMatch(arab,/reported designer clarifications|Rustan|Robert/);
    if(language!=='en-US') assert.ok(arab.includes('• '+text(language,'cardMachineTranslated')+'. '+text(language,'cardSource')+':'));
  }
});

test('agent appends only fixed links for sources actually read, including both note families', async () => {
  let round = 0, details;
  await investigateQuestion({question:'Do advisors bought from Poland reset?',language:'en-US',corpus:corpus(),apiKey:'test-only',reserveRequest(){},onAnswer:value=>{details=value;},
    fetcher:async(url,request)=>{
      assert.equal(url,'https://api.openai.com/v1/responses');
      assert.match(JSON.parse(request.body).instructions,/supplemental designer-reported clarifications/);
      round++;
      return Response.json({status:'completed',output:round===1 ? ['faq-amendments/poland','tabony-rules-differences/official-1'].map((id,index)=>({type:'function_call',name:'read_source',arguments:JSON.stringify({id,start:1,count:60}),call_id:String(index)})) :
        [{type:'message',content:[{type:'output_text',text:JSON.stringify({question_language:'en',answer_language:'en',english_question:null,parts:[{text:'Yes, limited uses reset for the buyer. faq-amendments/poland',english_text:null}]})}]}]});
    }});
  assert.deepEqual(details.sourceUrls,[rulesDifferencesUrl,faqAmendmentsUrl]);
  const footer=[...details.sourceUrls,questionSourceFooter(snapshot,'en-US')].join('\n');
  assert.ok(questionReplyParts(['a'.repeat(1800),'b'.repeat(1800)],footer).every(part=>part.length<=2000));
});
