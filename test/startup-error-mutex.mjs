import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderEventStream } from './regression/render-event-stream.mjs'

// 启动异常与「未配置 Agent」配置引导必须互斥：异常时只显示全屏重试，
// 配置引导只在无启动异常时出现，两者不得像启动截图那样叠在一起。
const startupHtml = readFileSync(new URL('../src/renderer/startup.html', import.meta.url), 'utf8')
const startupCss = readFileSync(new URL('../src/renderer/startup.css', import.meta.url), 'utf8')
const buildPlugins = [{ name: 'actual-startup', setup(builder) {
  builder.onLoad({ filter: /\/src\/renderer\/startup\.ts$/ }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'ts' }))
} }]

const setup = `
  import { NewTaskPanel } from './src/renderer/components/NewTaskPanel';
  window.uniagent = new Proxy({
    homeDir: '/fixture',
    listRequirements: async () => [],
    listProjects: async () => [],
    getPersonalAssistant: async () => null,
    getPrefs: async () => ({ lastByAgent: {} })
  }, { get: (target, key) => target[key] || (String(key).startsWith('on') ? () => () => {} : async () => []) });
  document.head.insertAdjacentHTML('beforeend', ${JSON.stringify(`<style>${startupCss}</style>`)});
  document.body.insertAdjacentHTML('afterbegin', ${JSON.stringify(startupHtml)});
  window.__startup = import('./src/renderer/startup');
  const fixture = document.createElement('div');
  fixture.className = 'app';
  document.body.appendChild(fixture);
  createRoot(fixture).render(React.createElement(NewTaskPanel, {
    agents: [], loading: false,
    onCreate: async () => { throw Error('unexpected create'); },
    onCommitCreatedSession: () => {}
  }));
`

const inspect = (body) => `(async () => {
  const api = await window.__startup;
  const screen = document.getElementById('ua-startup');
  const workbench = document.querySelector('.app');
  const configUi = () => document.querySelector('.first-setup');
  const restart = document.getElementById('ua-startup-restart');
  const title = document.getElementById('ua-startup-title');
  const opaque = () => {
    const style = getComputedStyle(screen);
    return style.backgroundColor === 'rgb(15, 16, 17)' && style.opacity === '1';
  };
  ${body}
})()`

// 场景一：正常进场后展示配置引导；随后迟到的启动异常必须整屏接管并藏起配置引导。
const entryThenLateError = await renderEventStream([], 'idle', 'entry-then-late-error', {
  setup, buildPlugins,
  inspect: inspect(`
    api.enterStartup(() => { window.__entered = true; });
    for (let i = 0; i < 250 && !screen.hidden; i++) await new Promise(resolve => setTimeout(resolve, 20));
    const result = {
      enteredHidden: screen.hidden === true && window.__entered === true,
      configUiAfterEntry: !!configUi() && getComputedStyle(configUi()).visibility !== 'hidden',
      workbenchVisibleAfterEntry: getComputedStyle(workbench).visibility !== 'hidden'
    };
    api.updateStartup('', true);
    result.errorResurfaced = screen.hidden === false && screen.classList.contains('error');
    result.opaqueOnError = opaque();
    result.workbenchHiddenOnError = getComputedStyle(workbench).visibility === 'hidden';
    result.configUiHiddenOnError = !!configUi() && getComputedStyle(configUi()).visibility === 'hidden';
    return result;
  `)
})
assert.equal(entryThenLateError.enteredHidden, true, '加载完成后应隐藏启动层并进入工作台')
assert.equal(entryThenLateError.configUiAfterEntry, true, '未配置 Agent 且无启动异常时应显示配置引导')
assert.equal(entryThenLateError.workbenchVisibleAfterEntry, true, '进场完成后工作台应可见')
assert.equal(entryThenLateError.errorResurfaced, true, '迟到的启动异常必须重新接管为全屏重试')
assert.equal(entryThenLateError.opaqueOnError, true, '异常接管必须是不透明遮罩')
assert.equal(entryThenLateError.workbenchHiddenOnError, true, '启动异常时不得露出工作台')
assert.equal(entryThenLateError.configUiHiddenOnError, true, '启动异常时不得显示配置引导')

// 场景二：启动异常后只显示重试界面，后续进场请求必须被拒绝。
const errorTakeover = await renderEventStream([], 'idle', 'error-takeover', {
  setup, buildPlugins,
  inspect: inspect(`
    api.updateStartup('', true);
    const result = {
      errorOnlyState: screen.classList.contains('error') && !screen.classList.contains('entering'),
      opaque: opaque(),
      title: title.textContent,
      restartShown: restart.hidden === false,
      workbenchHidden: getComputedStyle(workbench).visibility === 'hidden',
      configUiHidden: !!configUi() && getComputedStyle(configUi()).visibility === 'hidden'
    };
    api.enterStartup(() => { window.__entered = true; });
    result.enterRefused = !screen.classList.contains('entering') && window.__entered !== true && screen.hidden === false;
    return result;
  `)
})
assert.equal(errorTakeover.errorOnlyState, true, '异常态不得携带进场样式')
assert.equal(errorTakeover.opaque, true, '异常遮罩必须不透明')
assert.equal(errorTakeover.title, '启动异常')
assert.equal(errorTakeover.restartShown, true, '异常态只提供重新启动')
assert.equal(errorTakeover.workbenchHidden, true, '异常态下工作台必须隐藏')
assert.equal(errorTakeover.configUiHidden, true, '异常态下配置引导必须隐藏')
assert.equal(errorTakeover.enterRefused, true, '异常后不得再进入工作台动画')

// 场景三：进场动画进行中发生启动异常，不得残留透明进场态与开幕帘幕。
const enterThenError = await renderEventStream([], 'idle', 'enter-then-error', {
  setup, buildPlugins,
  inspect: inspect(`
    api.enterStartup(() => {});
    api.updateStartup('', true);
    await new Promise(resolve => setTimeout(resolve, 50));
    return {
      enteringGone: !screen.classList.contains('entering'),
      errorOn: screen.classList.contains('error'),
      curtainsGone: screen.querySelectorAll('.startup-curtain, .startup-edge').length === 0,
      opaque: opaque(),
      workbenchHidden: getComputedStyle(workbench).visibility === 'hidden'
    };
  `)
})
assert.equal(enterThenError.enteringGone, true, '异常时必须移除进场态')
assert.equal(enterThenError.errorOn, true)
assert.equal(enterThenError.curtainsGone, true, '异常时必须清掉入场帘幕残留')
assert.equal(enterThenError.opaque, true, '进场中转异常也必须回到不透明遮罩')
assert.equal(enterThenError.workbenchHidden, true)

// 场景四：即使 error 与 entering 同时存在（历史混合态），错误屏也必须保持不透明全屏接管。
const forcedBlend = await renderEventStream([], 'idle', 'forced-both-classes', {
  setup, buildPlugins,
  inspect: inspect(`
    screen.classList.add('entering', 'error');
    restart.hidden = false;
    await new Promise(resolve => setTimeout(resolve, 500));
    return {
      opaque: opaque(),
      titleVisible: getComputedStyle(title).opacity === '1',
      workbenchHidden: getComputedStyle(workbench).visibility === 'hidden',
      configUiHidden: !!configUi() && getComputedStyle(configUi()).visibility === 'hidden'
    };
  `)
})
assert.equal(forcedBlend.opaque, true, 'error 与 entering 并存时背景仍须不透明（启动混合截图回归）')
assert.equal(forcedBlend.titleVisible, true, '异常标题不得被进场动画淡出')
assert.equal(forcedBlend.workbenchHidden, true, '错误屏必须遮住工作台')
assert.equal(forcedBlend.configUiHidden, true, '错误屏必须遮住配置引导')

console.log('startup error / first-setup mutual exclusion: ok')
