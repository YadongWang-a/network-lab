/**
 * WF-25 路由器端口随连线数浮动：基础 3 口、恒留 1 个空口、断开回收、上限 8、
 * 手动配过 IP 的追加端口不回收。断言口径 = store 终态的可观测契约（接口名/数量）。
 */
import { beforeEach, describe, expect, test } from 'vitest';
import { useStore } from '@/state/store';
import { KIND_INTERFACES, ROUTER_MAX_PORTS } from '@/domain/deviceFactory';
import { DEFAULT_SUBNETS } from '@/domain/ipam';

beforeEach(() => useStore.setState({ topology: { devices: {}, connections: [] } }));

/** 一台路由器 + 一台交换机（同一交换机可承接多根线缆）。 */
function setup() {
  const st = useStore.getState();
  return {
    router: st.addDevice('router', { position: { x: 0, y: 0 } }),
    sw: st.addDevice('switch', { position: { x: 1, y: 0 } }),
  };
}

function portsOf(id: string) {
  return Object.values(useStore.getState().topology.devices[id].interfaces);
}

describe('路由器端口随连线数浮动', () => {
  test('新建 = 基础 3 口（enp0s3/8/9），各占一个默认子网网关', () => {
    const { router } = setup();
    const ports = portsOf(router);

    expect(ports.map((f) => f.name)).toEqual([...KIND_INTERFACES.router]);
    expect(ports.map((f) => f.ip)).toEqual(DEFAULT_SUBNETS.map((c) => `${c.split('.').slice(0, 3).join('.')}.1`));
    expect(ports.every((f) => f.connectedSwitchId === null)).toBe(true);
  });

  test('占满 3 口即追加第 4 口（enp0s10；池中无对应子网 → 无 IP，待手动配置）', () => {
    const { router, sw } = setup();
    const st = useStore.getState();
    st.addConnection(router, 'enp0s3', sw);
    st.addConnection(router, 'enp0s8', sw);

    expect(portsOf(router)).toHaveLength(3); // 仍留 2 个空口

    st.addConnection(router, 'enp0s9', sw);
    const ports = portsOf(router);
    expect(ports.map((f) => f.name)).toEqual(['enp0s3', 'enp0s8', 'enp0s9', 'enp0s10']);
    expect(ports[3].ip).toBeNull();
    expect(ports.filter((f) => f.connectedSwitchId === null)).toHaveLength(1); // 恒留 1 空口
  });

  test('断开连线回收多余空口，回落到基础 3 口', () => {
    const { router, sw } = setup();
    const st = useStore.getState();
    for (const name of KIND_INTERFACES.router) st.addConnection(router, name, sw);
    expect(portsOf(router)).toHaveLength(4);

    st.removeConnection(router, 'enp0s9');
    expect(portsOf(router).map((f) => f.name)).toEqual([...KIND_INTERFACES.router]);
  });

  test('上限 8 口：占满 8 口不再追加（UI 提示端口上限）', () => {
    const { router, sw } = setup();
    const st = useStore.getState();
    for (const name of KIND_INTERFACES.router) st.addConnection(router, name, sw);
    // 逐个占掉空口：每次占满最后一个空口都会再补新口，直到触顶 8 口（无空口可占）。
    for (let i = 0; i < ROUTER_MAX_PORTS * 2; i++) {
      const free = portsOf(router).find((f) => f.connectedSwitchId === null);
      if (!free) break;
      st.addConnection(router, free.name, sw);
    }
    const ports = portsOf(router);
    expect(ports).toHaveLength(ROUTER_MAX_PORTS);
    expect(ports.every((f) => f.connectedSwitchId !== null)).toBe(true);
    expect(ports[ROUTER_MAX_PORTS - 1].name).toBe('enp0s14');
  });

  test('手动配过 IP 的追加端口在断开后保留（不回收用户配置）', () => {
    const { router, sw } = setup();
    const st = useStore.getState();
    for (const name of KIND_INTERFACES.router) st.addConnection(router, name, sw);
    st.updateInterface(router, 'enp0s10', { ip: '192.168.9.1', netmask: '255.255.255.0' });

    st.removeConnection(router, 'enp0s3');
    expect(portsOf(router).map((f) => f.name)).toEqual(['enp0s3', 'enp0s8', 'enp0s9', 'enp0s10']);
    expect(portsOf(router)[3].ip).toBe('192.168.9.1');
  });

  test('删除交换机同样回收路由器空口', () => {
    const { router, sw } = setup();
    const st = useStore.getState();
    for (const name of KIND_INTERFACES.router) st.addConnection(router, name, sw);
    expect(portsOf(router)).toHaveLength(4);

    st.removeDevice(sw);
    expect(portsOf(router).map((f) => f.name)).toEqual([...KIND_INTERFACES.router]);
  });
});
