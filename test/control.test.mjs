/**
 * 状态文案的回归测试。
 *
 * 起因：2026-11-20 在真机上按「继续」（QQ音乐 22.76），控制脚本回
 * `status: "Opened"`，`statusText` 没有这一档，于是工具回执里出现
 * 「现在 《Reach Out To The Truth》，Opened。」——模型会把这句英文原样说出来。
 *
 * SMTC 的枚举一共六档：Closed / Opened / Changing / Stopped / Playing / Paused。
 * 断言全六档都有中文，以后再加档位漏了会红。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { statusText } from '../src/control.ts';

test('SMTC 六档状态全部有中文，不把英文甩给模型', () => {
  const cases = {
    Closed: '已关闭',
    Opened: '刚起播',
    Changing: '切换中',
    Stopped: '已停止',
    Playing: '在放',
    Paused: '已暂停',
  };
  for (const [raw, want] of Object.entries(cases)) {
    assert.equal(statusText(raw), want, `${raw} 的文案不对`);
    assert.ok(!/^[A-Za-z]+$/.test(statusText(raw)), `${raw} 还在输出英文`);
  }
});

test('未知与缺省状态不炸', () => {
  assert.equal(statusText(undefined), '状态未知');
  assert.equal(statusText('Whatever'), 'Whatever');
});
