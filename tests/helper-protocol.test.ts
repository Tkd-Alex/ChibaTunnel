import assert from 'node:assert/strict'
import test from 'node:test'
import { parseHelperCommand } from '../src/main/helper-protocol'

test('accepts typed helper requests', () => {
  assert.deepEqual(parseHelperCommand({ command: 'ping' }), { command: 'ping' })
  assert.deepEqual(parseHelperCommand({
    command: 'start-transparent',
    tun2socksPath: '/opt/chibatunnel/tun2socks',
    socksPort: 1080,
    serverIp: '203.0.113.10',
    killSwitch: true
  }), {
    command: 'start-transparent',
    tun2socksPath: '/opt/chibatunnel/tun2socks',
    socksPort: 1080,
    serverIp: '203.0.113.10',
    killSwitch: true
  })
  assert.deepEqual(parseHelperCommand({
    command: 'wg-up',
    configFile: '/tmp/chibatunnel-wg-123/tunnel.conf',
    wgPath: '/usr/bin/wg-quick'
  }), {
    command: 'wg-up',
    configFile: '/tmp/chibatunnel-wg-123/tunnel.conf',
    wgPath: '/usr/bin/wg-quick'
  })
  assert.deepEqual(parseHelperCommand({
    command: 'awg-down',
    configFile: '/tmp/chibatunnel-awg-123/chibaawg0.conf',
    awgPath: '/usr/bin/awg-quick'
  }), {
    command: 'awg-down',
    configFile: '/tmp/chibatunnel-awg-123/chibaawg0.conf',
    awgPath: '/usr/bin/awg-quick'
  })
  assert.deepEqual(parseHelperCommand({
    command: 'hysteria2-start',
    configFile: '/tmp/chibatunnel-hysteria2-123/client.yaml',
    hysteria2Path: '/usr/bin/hysteria2'
  }), {
    command: 'hysteria2-start',
    configFile: '/tmp/chibatunnel-hysteria2-123/client.yaml',
    hysteria2Path: '/usr/bin/hysteria2'
  })
  assert.deepEqual(parseHelperCommand({ command: 'hysteria2-stop' }), {
    command: 'hysteria2-stop'
  })
})

test('rejects unknown commands and unexpected fields', () => {
  assert.throws(() => parseHelperCommand({ command: 'shell', value: 'id' }), /Unknown helper command/)
  assert.throws(() => parseHelperCommand({ command: 'ping', executable: '/bin/sh' }), /Unexpected helper field/)
})

test('rejects command injection and path traversal inputs', () => {
  assert.throws(() => parseHelperCommand({
    command: 'wg-up',
    configFile: '/etc/passwd',
    wgPath: '/bin/sh'
  }), /approved runtime directory/)
  assert.throws(() => parseHelperCommand({
    command: 'wg-up',
    configFile: '/tmp/chibatunnel-ok/../outside/tunnel.conf',
    wgPath: '/usr/bin/wg-quick'
  }), /traversal/)
  assert.throws(() => parseHelperCommand({
    command: 'wg-up',
    configFile: '/tmp/chibatunnel-ok/tunnel;touch-pwned.conf',
    wgPath: '/usr/bin/wg-quick'
  }), /name is not allowed/)
  assert.throws(() => parseHelperCommand({
    command: 'start-transparent',
    tun2socksPath: '/tmp/tun2socks;touch-pwned',
    socksPort: 1080,
    serverIp: '203.0.113.10'
  }), /allowlisted/)
  assert.throws(() => parseHelperCommand({
    command: 'awg-up',
    configFile: '/tmp/chibatunnel-awg-123/chibaawg0.conf',
    awgPath: '/bin/sh'
  }), /allowlisted/)
  assert.throws(() => parseHelperCommand({
    command: 'hysteria2-start',
    configFile: '/tmp/chibatunnel-hysteria2-123/client.yaml',
    hysteria2Path: '/bin/sh'
  }), /allowlisted/)
})

test('rejects invalid ports and IP addresses', () => {
  const base = {
    command: 'start-transparent',
    tun2socksPath: '/opt/chibatunnel/tun2socks',
    socksPort: 1080,
    serverIp: '203.0.113.10'
  }
  assert.throws(() => parseHelperCommand({ ...base, socksPort: 0 }), /socksPort/)
  assert.throws(() => parseHelperCommand({ ...base, socksPort: 65536 }), /socksPort/)
  assert.throws(() => parseHelperCommand({ ...base, serverIp: '999.1.1.1' }), /serverIp/)
  assert.throws(() => parseHelperCommand({ ...base, serverIp: '::1' }), /serverIp/)
})
