/* Local transport for Tabony's native canvas renderer. No live-game socket. */
(() => {
  sessionStorage.setItem('page_title','Nations · Local evaluation');
  let revision = null, current = null, socket = null, queue = Promise.resolve();
  const el = id => document.getElementById(id);
  const modeNames = {easy:'Easy',medium:'Medium',human:'Human replay policy'};
  const fail = error => { if(el('local-error'))el('local-error').textContent=error.message; };
  async function api(path, payload) {
    const response = await fetch(path,{method:payload===undefined?'GET':'POST',cache:'no-store',headers:{'content-type':'application/json'},...(payload===undefined?{}:{body:JSON.stringify({...payload,revision})})});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Local request failed.');
    return data;
  }
  function formatMove(move, state) {
    const names = JSON.parse(el('card-abbrs').textContent);
    const own=state.players?.[state.next_move_player];
    return move.replace(/\b(P\d+)\b/g,slot=>`${slot} (${names[state.progress_board?.[slot]]||'empty'})`)
      .replace(/\b(BM\d+)\b/g,slot=>`${slot} (${names[own?.slots?.[slot]]||'empty'})`);
  }
  function publish(game) {
    const identity=document.getElementById('username');
    if(game.view.mode==='play'&&identity&&JSON.parse(identity.textContent)!==game.human){location.reload();return}
    // The upstream renderer normally lives on one match page. Local replay
    // switching can change its roster without navigation, so invalidate its
    // per-match colour map and selected board before delivering the new state.
    if(current&&JSON.stringify(current.first_round_player_order)!==JSON.stringify(game.first_round_player_order)){
      window.player_to_color=null;window.show_player_board=null;
    }
    if(current&&(current.move_number!==game.move_number||current.revision!==game.revision||current.view.mode!==game.view.mode)){
      el('analysis-details').open=false;
      el('analysis-output').textContent='Choose “Explain position” to compare the bots at this decision.';
    }
    current=game;revision=game.revision;
    el('asset-status').textContent=game.native_assets?`${game.native_assets} native assets cached locally`:'Native artwork is cached locally as it loads.';
    const difficulty=game.difficulty??'easy', mode=modeNames[difficulty];
    el('difficulty').querySelector('option[value="human"]').disabled=!game.difficulties?.includes('human');
    el('difficulty').value=difficulty;
    el('local-status').textContent=game.view.mode==='play'?`Playing locally against ${mode}`:game.view.label+' · read-only replay';
    el('position-label').textContent=`Decision ${game.move_number} / ${game.view.max_position}`;
    el('position-range').min=game.view.min_position??0;el('position-range').max=game.view.max_position;el('position-range').value=game.move_number;
    el('take-branch').disabled=!game.view.can_branch||game.game_over;
    const seat=el('branch-player'),selected=seat.value;seat.replaceChildren();for(const name of game.player_order){const option=document.createElement('option');option.value=name;option.textContent=name;seat.append(option)}seat.value=game.player_order.includes(selected)?selected:game.player_order.includes(game.human)?game.human:game.player_order[0];
    el('save-local').href=game.view.replay_available?'/api/replay':'/api/snapshot';el('save-local').textContent=game.view.replay_available?'Save replay':'Save position';
    el('previous-position').disabled=game.move_number<=(game.view.min_position??0);
    el('next-position').disabled=game.move_number>=game.view.max_position;
    const last=game.bot_decisions?.findLast(row=>row.difficulty===difficulty&&row.choice==='Which action?')??game.bot_decisions?.at(-1);
    el('local-timing').textContent=last?`Last ${modeNames[last.difficulty]} decision: ${last.duration_ms<100?`${last.duration_ms.toFixed(1)} ms`:`${(last.duration_ms/1000).toFixed(2)} s`} · ${last.label}${last.search?.completedDepth?` · ${last.search.completedDepth} levels searched`:''}`:'';
    el('local-error').textContent='';
    const message={players:game.player_order,accepted:game.player_order,growth_resources:Object.fromEntries(game.player_order.map(name=>[name,2])),
      state:game,log:game.full_log||game.log.join('\n'),replaying:game.view.mode!=='play',replay_position:game.move_number,move_number:game.view.max_position};
    socket?.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(message)}));
  }
  async function seek(command) { publish(await api('/api/position',{command})); }
  class LocalSocket extends EventTarget {
    static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;
    readyState=0;
    constructor(url){super();if(!url.includes('/ws/nations/local/'))throw new Error('Only the local board transport is available.');socket=this;setTimeout(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));},0)}
    send(text){const message=JSON.parse(text);queue=queue.then(async()=>{if(message===null){publish(await api('/api/game'));return}if('move'in message){publish(await api('/api/move',{move:message.move}));return}if(message.replay){await seek(message.replay);return}if('notes'in message)localStorage.setItem('nations-local-notes',message.notes);}).catch(error=>{fail(error);return api('/api/game').then(publish).catch(fail)});}
    close(){if(this.readyState===3)return;this.readyState=3;this.dispatchEvent(new Event('close'))}
  }
  window.WebSocket=LocalSocket;
  document.addEventListener('DOMContentLoaded',()=>{
    const action=fn=>()=>{queue=queue.then(fn).catch(fail)};
    el('new-local').onclick=action(async()=>publish(await api('/api/new',{difficulty:el('difficulty').value})));
    el('difficulty').onchange=action(async()=>publish(await api('/api/settings',{difficulty:el('difficulty').value})));
    el('resume-local').onclick=action(async()=>publish(await api('/api/resume',{})));
    el('review-opening').onclick=action(async()=>publish(await api('/api/review',{fixture:'3272'})));
    el('open-replay').onchange=action(async()=>{const file=el('open-replay').files[0];if(!file)return;if(file.size>2*1024*1024)throw new Error('Replay is too large (maximum 2 MB).');publish(await api('/api/review',{replay:await file.text()}));el('open-replay').value='';});
    el('previous-position').onclick=action(()=>seek({back:1}));el('next-position').onclick=action(()=>seek({forward:1}));
    el('position-range').onchange=action(()=>seek({to:Number(el('position-range').value)}));
    el('take-branch').onclick=action(async()=>publish(await api('/api/branch',{human:el('branch-player').value})));
    el('explain-position').onclick=action(async()=>{
      el('analysis-details').open=true;el('analysis-output').textContent='Evaluating…';
      const result=await api('/api/analyze');
      const lines=[`Decision ${current.move_number}: ${current.next_move_player} — ${current.next_move_choice}`,'Easy scorer:',...result.moves.slice(0,3).map(row=>`${formatMove(row.move,current)}: ${row.score.toFixed(2)}`)];
      const predictive=result.predictive;
      if(predictive){
        lines.push(`\nDeterministic lookahead · ${predictive.model}`);
        if(predictive.unavailable)lines.push(predictive.unavailable);
        else{
          const percentage=value=>value==null?'No estimate':`${(100*value).toFixed(1)}% estimated win probability`;
          lines.push(`${predictive.moves.length} of ${predictive.legalChoices} choices explored for ${predictive.player} · ${predictive.completedDepth} levels · ${predictive.nodes} branches`);
          if(predictive.rootWinProbability!=null)lines.push(`Current position: ${percentage(predictive.rootWinProbability)}`);
          if(predictive.recommendedMove)lines.push(`Recommended: ${formatMove(predictive.recommendedMove,current)}`);
          if(!predictive.moves.some(row=>row.comparable))lines.push('No shared stopping point for comparison. Keeping the direct policy choice.');
          for(const row of predictive.moves){
            lines.push(`${formatMove(row.move,current)}: ${percentage(row.winProbability)} · ${row.stop}${row.winProbability!=null&&!row.comparable?' · preview only':''}`);
            lines.push(`  ${row.line.map(step=>`${step.player}: ${step.move}`).join(' → ')}`);
          }
          if(predictive.budgetReached)lines.push('Time or node limit reached.');
          lines.push(`Opponent replies are compared among up to ${predictive.replyWidth} shortlisted moves.`);
        }
      }
      if(result.human){
        lines.push('\nHuman replay policy:');
        if(result.placement?.length){
          lines.push('Placements compared using the local game engine.');
          for(const [index,row] of result.placement.entries()){
            const replacement=row.old_card?`replaces ${row.old_card}`:'empty slot';
            lines.push(`${index+1}. ${row.move} (${replacement}) · ${row.displaced_workers} workers returned · ${row.military_after_deploy} Military after up to one deploy`);
          }
          const best=result.placement[0];
          if(best.rivals_below_strength_after_one_deploy.length)lines.push(`Available wars include ${best.affordable_wars.join(', ')}. ${best.rivals_below_strength_after_one_deploy.join(', ')} cannot match that strength with one ordinary deploy.`);
        }
        else if(result.human.fallback)lines.push('This prompt uses Easy.');
        else {
          lines.push(...result.human.moves.slice(0,3).map(({move},index)=>`${index+1}. ${formatMove(move,current)}`));
          for (const row of result.human.moves.filter(row=>row.reasons?.length)) {
            const change=row.next_deploy?' plans a worker transfer':row.score>row.learned_score?' ranks higher':' ranks lower';
            lines.push(`${formatMove(row.move,current)}${change}. ${row.reasons.join(' ')}`);
          }
        }
      }
      const medium=result.medium;
      if(medium){
        lines.push('\nMedium lookahead (relative position estimate; a different scale from Easy):',
          `${medium.completedDepth} of ${medium.depth} levels completed · ${medium.nodes} searched nodes · ${((medium.duration_ms??0)/1000).toFixed(2)} s`);
        if(medium.fallback)lines.push(`Fallback: ${medium.fallback}`);
        medium.moves.slice(0,3).forEach((row,index)=>{
          lines.push(`${formatMove(row.move,current)}: ${row.unmodelled?'not simulated':row.score.toFixed(2)}`);
          if(index===0)lines.push(...(row.plan??[]).map(step=>`  ${step}`));
        });
        lines.push('Prototype: public information and common actions only. Special card effects and round resolution are incomplete.');
      }
      const reading=result.reading;
      if(reading.draft)for(const nation of reading.draft)for(const race of nation.colonies){const plan=race.routes[reading.player]?.plan;if(plan)lines.push(`${nation.nation} → ${race.name}: ${plan.turns} actions (${plan.actions.join(' → ')})`);}
      for(const race of reading.colonies){lines.push(`\n${race.name} (${race.requiredMilitary} Military, ${race.price} Gold):`);for(const [name,route]of Object.entries(race.routes))lines.push(`${name}: ${route.plan?route.plan.actions.join(' → '):'no basic route found within the search budget'}`);for(const choice of race.deployments){
        const easyRank=result.moves.findIndex(row=>row.move===choice.move)+1;
        const mediumRank=medium?.moves.findIndex(row=>row.move===choice.move)+1;
        lines.push(`${formatMove(choice.move,current)}: ${choice.beatsKnownRivalPlans?'keeps an earlier purchase':'allows a rival to arrive first or leaves no route'}${easyRank&&mediumRank?` · Easy #${easyRank}, Medium #${mediumRank}`:''}`);
      }}
      for(const row of reading.growth||[])lines.push(`${row.growth}, then ${row.colony} and owned Food production: ${row.foodBeforeFamine} Food before famine; ${row.goldAfterProduction} Gold and ${row.stoneAfterProduction} Stone after production.`);
      lines.push('\nReading covers basic visible routes. Specials, discounts and full rival strategy still need modelling.');el('analysis-output').textContent=lines.join('\n');
    });
  });
})();
