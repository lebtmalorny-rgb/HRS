// Checks illustrative research traces, not production execution or a formal model.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');

const html = readFileSync(resolve(__dirname, '../visualizations/ha-recovery-animation.html'), 'utf8');
const region = html.match(/\/\/ TRACE DATA START([\s\S]*?)\/\/ TRACE DATA END/);
assert.ok(region, 'HTML must expose its executable trace data region');
const traces = vm.runInNewContext(`${region[1]}\n;traces`, { structuredClone }, { timeout: 1000 });
const modes = ['normal', 'lost', 'hold', 'planned', 'contention', 'return', 'unknown'];
const final = mode => traces[mode].frames.at(-1).state;
const incremented = (a, b, key) => b.counts[key] > a.counts[key];
const novaDown = state => state.knowledge.sourceService.replace(/\s/g, '') === 'disabled/down';

test('research traces preserve temporal recovery and coordination invariants', async t => {
  const missing = modes.filter(mode => !traces[mode]);
  assert.equal(missing.length, 0, `Missing composite scenarios: ${missing.join(', ')}`);

  await t.test('every scenario supplies observable frames and explicit research assumptions', () => {
    for (const mode of modes) {
      const trace = traces[mode];
      assert.ok(trace.id && trace.profile && trace.contract && trace.assumptions, mode);
      assert.ok(trace.frames.length > 1, `${mode}: a trace must contain transitions`);
      for (const frame of trace.frames) {
        assert.ok(frame.id && frame.title && frame.detail && frame.state, mode);
        if (frame.signal) assert.ok(frame.signal.from && frame.signal.to && frame.signal.kind, mode);
      }
    }
  });

  await t.test('submission follows saved intent, VM claim, fencing and Nova evidence', () => {
    let submissions = 0;
    for (const mode of modes) for (const [i, frame] of traces[mode].frames.entries()) {
      const s = frame.state, p = traces[mode].frames[i - 1]?.state;
      assert.ok(!(s.world.sourceVM === 'running' && s.world.targetVM === 'running'), `${mode}: duplicate execution`);
      if (!p) continue;
      if ((!p.evacuation.submitted && s.evacuation.submitted) || incremented(p, s, 'evacuate')) {
        submissions++;
        assert.equal(p.evacuation.intent, 'SUBMITTING', `${mode}: intent must precede submission`);
        assert.equal(p.evacuation.vmClaim, true, `${mode}: VM claim must precede submission`);
        assert.equal(s.knowledge.power, 'off', `${mode}: missing Off evidence`);
        assert.ok(novaDown(s), `${mode}: missing disabled/down evidence`);
      }
    }
    assert.ok(submissions > 0, 'successful and ambiguous evacuation paths must be exercised');
  });

  await t.test('admitted claims survive active, cooling and unknown operations until DONE', () => {
    const seen = new Set();
    for (const mode of modes) for (const [i, frame] of traces[mode].frames.entries()) {
      const e = frame.state.evacuation, p = traces[mode].frames[i - 1]?.state.evacuation;
      if (['RUNNING', 'COOLDOWN', 'UNKNOWN'].includes(e.operation)) {
        seen.add(e.operation);
        for (const key of ['vmClaim', 'targetClaim', 'slotClaim']) assert.equal(e[key], true, `${mode}: ${e.operation} lost ${key}`);
      }
      if (p) for (const key of ['vmClaim', 'targetClaim', 'slotClaim']) {
        if (p[key] && !e[key]) assert.equal(e.operation, 'DONE', `${mode}: premature ${key} release`);
      }
    }
    for (const operation of ['RUNNING', 'COOLDOWN', 'UNKNOWN']) assert.ok(seen.has(operation), `${operation} must be represented`);
  });

  await t.test('normal completion frees ownership while Watcher remains blocked', () => {
    const s = final('normal');
    assert.equal(s.host.owner, 'none');
    assert.equal(s.watcher.state, 'BLOCKED');
    assert.equal(s.evacuation.proof, true);
    assert.equal(s.evacuation.observation, 'CONFIRMED');
    assert.equal(s.evacuation.operation, 'DONE');
    assert.equal(s.world.targetVM, 'running');
  });

  await t.test('new API hold rotates the Watcher epoch once for the incident', () => {
    const frames = traces.normal.frames;
    const held = frames.findIndex(f => f.state.watcher.state === 'BLOCKED');
    assert.ok(held > 0, 'normal recovery must newly block Watcher');
    assert.equal(frames[held - 1].state.watcher.state, 'READY');
    assert.notEqual(frames[held].state.watcher.epoch, frames[held - 1].state.watcher.epoch, 'a new hold must invalidate the previous epoch');
    for (const f of frames.slice(held)) assert.equal(f.state.watcher.epoch, frames[held].state.watcher.epoch, 'repeated hold for the same incident must preserve its epoch');
  });

  await t.test('normal evacuation confirmation includes Nova observation of the destination', () => {
    const frames = traces.normal.frames;
    const submitted = frames.findIndex(f => f.state.evacuation.submitted);
    const confirmed = frames.findIndex(f => f.state.evacuation.observation === 'CONFIRMED');
    assert.ok(submitted >= 0 && confirmed > submitted, 'confirmation must follow evacuation submission');
    assert.ok(frames.some((f, i) => i > submitted && i <= confirmed && f.signal?.from === 'nova'
      && f.signal?.to === 'controller' && f.signal?.kind === 'observation' && f.state.knowledge.vmHost === 'Hdst'), 'etcd completion proof alone cannot establish Nova destination observation');
  });

  await t.test('Nova schedules through conductor before dispatch and receiving admission', () => {
    for (const mode of ['normal', 'contention', 'unknown']) {
      const frames = traces[mode].frames;
      const at = (from, to) => frames.findIndex(f => f.signal?.from === from && f.signal?.to === to);
      const handoff = at('nova', 'conductor'), schedule = at('conductor', 'scheduler');
      const selected = at('scheduler', 'conductor'), dispatch = at('conductor', 'compute');
      const admitted = frames.findIndex(f => f.state.evacuation.operation === 'RUNNING');
      assert.ok(handoff >= 0 && schedule > handoff && selected > schedule && dispatch > selected && admitted > dispatch, mode);
      const accepted = frames.findIndex(f => f.id.endsWith('-evacuate-accepted'));
      if (accepted >= 0) assert.ok(accepted > handoff, 'API dispatches conductor before replying to POST');
      assert.equal(frames[selected].state.scheduling.target, 'Hdst');
      assert.equal(frames[selected].state.world.targetVM, 'absent', 'selection is not execution');
      assert.equal(frames[dispatch].state.evacuation.operation, 'NONE', 'dispatch is not receiving admission');
    }
  });

  await t.test('source service evidence stays separate from destination service and VM observation', () => {
    const frames = traces.normal.frames, s = final('normal');
    assert.equal(s.knowledge.sourceService, 'disabled / down');
    assert.equal(s.knowledge.targetService, 'enabled / up');
    assert.equal(s.knowledge.vmHost, 'Hdst');
    assert.equal(s.knowledge.vmState, 'ACTIVE');
    const fenced = frames.find(f => f.state.world.sourcePower === 'off');
    assert.equal(fenced.state.knowledge.vmHost, 'Hsrc', 'physical fencing does not replace API observation');
    const rebuilt = frames.find(f => f.state.world.targetVM === 'running');
    assert.equal(rebuilt.state.knowledge.vmHost, 'Hsrc', 'rebuild does not refresh observer knowledge');
    assert.equal(rebuilt.state.knowledge.targetService, 'enabled / up');
  });

  await t.test('illustrated unknown schedule finishes Masakari before receiving operation becomes unknown', () => {
    const frames = traces.unknown.frames;
    const observed = frames.findIndex(f => f.state.evacuation.observation === 'UNKNOWN');
    const operationUnknown = frames.findIndex(f => f.state.evacuation.operation === 'UNKNOWN');
    assert.ok(observed >= 0 && operationUnknown > observed, 'observer uncertainty must precede the separate receiving failure');
    assert.equal(frames[observed].state.protocol.blocked, true, 'Masakari must block when its UNKNOWN observation is saved');
    assert.equal(frames[observed].signal?.to, 'controller');
    assert.equal(frames[observed].signal?.kind, 'observation');
    const released = frames.findIndex((f, i) => i > observed && f.state.host.owner === 'none' && frames[i - 1].state.host.owner === 'Masakari');
    assert.ok(released > observed && released < operationUnknown, 'this schedule must release Masakari ownership before the independent receiving failure');
    for (const [i, f] of frames.entries()) {
      if (i > observed) assert.ok(!(f.signal?.from === 'controller' && f.signal?.to === 'nova' && f.signal?.kind === 'command'), 'POST exception ends Masakari completion polling');
      if (i > 0 && ['compute', 'etcd'].includes(f.signal?.from) && ['compute', 'etcd'].includes(f.signal?.to))
        assert.equal(f.state.protocol.phase, frames[i - 1].state.protocol.phase, 'receiving compute coordination must not change Masakari phase');
      if (i >= operationUnknown) assert.notEqual(f.signal?.from, 'controller', 'Masakari has already exited before the receiving operation becomes UNKNOWN');
    }
  });

  await t.test('missing Off evidence prevents evacuation despite physical power-off', () => {
    const s = final('lost');
    assert.equal(s.world.sourcePower, 'off');
    assert.equal(s.knowledge.power, 'unknown');
    assert.equal(s.counts.evacuate, 0);
    assert.ok(traces.lost.frames.some(f => f.signal?.lost));
  });

  await t.test('policy hold never acquires host ownership or changes VM execution', () => {
    const initial = traces.hold.frames[0].state.world;
    for (const { state: s } of traces.hold.frames) {
      assert.equal(s.host.owner, 'none');
      for (const key of ['sourcePower', 'sourceVM', 'targetVM']) assert.equal(s.world[key], initial[key]);
      for (const key of ['fence', 'evacuate', 'powerOn']) assert.equal(s.counts[key], 0);
    }
  });

  await t.test('Mistral power commands require previously confirmed Mistral ownership', () => {
    let commands = 0;
    for (const mode of ['planned', 'return']) for (const [i, frame] of traces[mode].frames.entries()) {
      const s = frame.state, p = traces[mode].frames[i - 1]?.state;
      if (p && ['fence', 'powerOn'].some(key => incremented(p, s, key))) {
        commands++;
        assert.equal(p.host.owner, 'Mistral'); assert.equal(p.host.confirmed, true);
        assert.equal(s.host.owner, 'Mistral'); assert.equal(s.host.confirmed, true);
        assert.equal(frame.signal?.from, 'mistral'); assert.equal(frame.signal?.kind, 'command');
      }
    }
    assert.ok(commands > 0, 'planned maintenance and return must contain guarded power commands');
  });

  await t.test('physical power changes follow the authorized API, conductor and source BMC path', () => {
    let effects = 0;
    for (const mode of modes) {
      const frames = traces[mode].frames;
      for (const [i, frame] of frames.entries()) {
        const previous = frames[i - 1]?.state;
        if (!previous || previous.world.sourcePower === frame.state.world.sourcePower) continue;
        effects++;
        const before = frames.slice(0, i);
        const request = before.findLastIndex((f, j) => j > 0 && ['fence', 'powerOn'].some(key => incremented(frames[j - 1].state, f.state, key)));
        const conductor = before.findLastIndex(f => f.signal?.from === 'ironic' && f.signal?.to === 'ironicConductor' && f.signal?.kind === 'command');
        const bmc = before.findLastIndex(f => f.signal?.from === 'ironicConductor' && f.signal?.to === 'sourceBmc' && f.signal?.kind === 'command');
        assert.ok(request >= 0 && conductor > request && bmc > conductor, `${mode}: physical change needs the full authorized power path`);
        assert.equal(frames[request].signal?.to, 'ironic');
        assert.equal(frame.signal?.from, 'sourceBmc');
        assert.equal(frame.signal?.to, 'source');
        assert.equal(frame.signal?.kind, 'effect');
        for (const stage of frames.slice(request + 1, i)) {
          assert.equal(stage.state.world.sourcePower, frames[request].state.world.sourcePower, 'command forwarding is not physical completion');
          assert.deepEqual(stage.state.counts, frames[request].state.counts, 'forwarding does not issue another PowerOps action');
        }
      }
    }
    assert.equal(effects, 6, 'all six power-changing scenarios must exercise the path');
    assert.ok(traces.hold.frames.every(f => !['ironic', 'ironicConductor', 'sourceBmc'].includes(f.signal?.to)), 'policy hold must not send external power commands');
    assert.ok(traces.contention.frames.every(f => !(f.signal?.from === 'mistral' && ['ironic', 'ironicConductor', 'sourceBmc'].includes(f.signal?.to))), 'the losing Mistral contender must not send external power commands');
  });

  await t.test('return pauses without host ownership and reacquires it after the operator gate', () => {
    const frames = traces.return.frames;
    const pause = frames.findIndex(f => f.awaitOperator && f.state.mistral.workflow === 'PAUSED');
    assert.ok(pause >= 0, 'return needs an explicit operator gate');
    assert.equal(frames[pause].state.host.owner, 'none');
    const acquire = frames.findIndex((f, i) => i > pause && f.state.host.owner === 'Mistral' && !f.state.host.confirmed);
    const confirm = frames.findIndex((f, i) => i > acquire && acquire > pause && f.state.host.owner === 'Mistral' && f.state.host.confirmed);
    assert.ok(acquire > pause && confirm > acquire, 'return must confirm a newly acquired host lock');
    for (const f of frames.slice(pause)) assert.equal(f.state.counts.powerOn, frames[pause].state.counts.powerOn, 'return must not repeat power-on');
    assert.ok(frames.some((f, i) => i > confirm && f.signal?.from === 'mistral' && f.signal?.kind === 'command'
      && ['nova', 'masakari'].includes(f.signal.to) && f.state.host.owner === 'Mistral' && f.state.host.confirmed), 'return must issue an API command after renewed ownership confirmation');
    assert.equal(final('return').mistral.workflow, 'SUCCESS');
    assert.equal(final('return').host.owner, 'none');
  });

  await t.test('contention makes Mistral wait while Masakari owns the host', () => {
    const waiting = traces.contention.frames.filter(f => f.state.mistral.waiting);
    assert.ok(waiting.length > 0, 'contention needs a waiting contender');
    for (const f of waiting) assert.equal(f.state.host.owner, 'Masakari');
    for (const [i, f] of traces.contention.frames.entries()) {
      const p = traces.contention.frames[i - 1]?.state;
      if (p && ['fence', 'powerOn'].some(key => incremented(p, f.state, key))) assert.notEqual(f.signal?.from, 'mistral');
    }
  });

  await t.test('unknown observation retains claims and never retries evacuation', () => {
    const frames = traces.unknown.frames;
    const first = frames.findIndex(f => f.state.evacuation.observation === 'UNKNOWN');
    assert.ok(first >= 0, 'unknown response must be represented');
    for (const f of frames.slice(first)) {
      assert.equal(f.state.counts.evacuate, frames[first].state.counts.evacuate, 'ambiguous evacuation must not be retried');
      for (const key of ['vmClaim', 'targetClaim', 'slotClaim']) assert.equal(f.state.evacuation[key], true);
    }
    assert.equal(final('unknown').evacuation.operation, 'UNKNOWN');
    assert.equal(final('unknown').evacuation.proof, false);
  });
});
