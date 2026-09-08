/**
 * WF-12 场景 9：终端 FS 原语、WF-10 配置解析器、解析结果落 store → 引擎按新池分配。
 * 契约迁自 scripts/verify-engine.ts。
 */
import { beforeEach, describe, expect, test } from 'vitest';
import { SimulationEngine } from '@/engine/SimulationEngine';
import { useStore } from '@/state/store';
import { fsLs, fsMkdir, fsRead, fsWrite } from '@/domain/filesystem';
import type { DhcpdConfig } from '@/domain/types';
import {
  parseApacheVhost,
  parseDbFile,
  parseDhcpdConf,
  parseNamedConfLocal,
  parseNetworkInterfaces,
} from '@/parsers/config';
import { ctx, dev, dhcpLayer, drain, resetTopology, typedPackets } from '../helpers/engine';

beforeEach(resetTopology);

function setup(): { pc0: string; server: string } {
  const st = useStore.getState();
  const sw0 = st.addDevice('switch', { position: { x: 0, y: 0 } });
  const pc0 = st.addDevice('pc', { position: { x: 1, y: 0 } });
  const server = st.addDevice('dhcp-server', { position: { x: 2, y: 0 } });
  st.addConnection(pc0, 'enp0s3', sw0);
  st.addConnection(server, 'enp0s3', sw0);
  st.updateInterface(pc0, 'enp0s3', { ip: null, netmask: null, gateway: null });
  return { pc0, server };
}

describe('终端 FS 原语（WF-11 底层）', () => {
  test('写读一致 + mkdir/ls + 中文错误', () => {
    const { pc0 } = setup();
    const st = useStore.getState();
    const fs = dev(pc0).filesystem;
    const withDirs = fsMkdir(fsMkdir(fsMkdir(fs, '/var/log', []), '/var/log/app', []), '/root', []);
    const written = fsWrite(withDirs, '/etc/hosts.bak', '127.0.0.1 localhost\n', []);
    st.updateDevice(pc0, { filesystem: written });

    expect(fsRead(dev(pc0).filesystem, '/etc/hosts.bak', [])).toContain('127.0.0.1');
    expect(fsLs(dev(pc0).filesystem, '/var/log', [])).toContain('app/');
    expect(() => fsRead(dev(pc0).filesystem, '/no/such/file', [])).toThrow('不存在');
  });
});

describe('配置解析器（WF-10）', () => {
  test('network-interfaces：static/dhcp 块 + 非法 IP 行号报错', () => {
    const netCfg = parseNetworkInterfaces(
      '# comment\niface enp0s3 inet static address 10.0.0.5 netmask 255.255.255.0 gateway 10.0.0.1\niface enp0s3 inet dhcp',
      ['enp0s3'],
    );
    expect(netCfg).toHaveLength(2);
    const first = netCfg[0]!;
    expect(first.mode === 'static' ? first.address : first.mode).toBe('10.0.0.5');
    expect(() => parseNetworkInterfaces('iface enp0s3 inet static address 999.1.1.1 netmask 255.255.255.0', ['enp0s3'])).toThrow(/第 1 行.*999/s);
  });

  test('dhcpd.conf：range/routers/subnet-mask/dns/lease', () => {
    const dhcpConf = parseDhcpdConf([
      'subnet 192.168.1.0 netmask 255.255.255.0 {',
      '  range 192.168.1.150 192.168.1.160;',
      '  option routers 192.168.1.1;',
      '  option subnet-mask 255.255.255.0;',
      '  option domain-name-servers 192.168.1.9;',
      '  default-lease-time 7200;',
      '}',
    ].join('\n'));
    expect(dhcpConf.rangeStart).toBe('192.168.1.150');
    expect(dhcpConf.rangeEnd).toBe('192.168.1.160');
    expect(dhcpConf.gateway).toBe('192.168.1.1');
    expect(dhcpConf.dns).toBe('192.168.1.9');
    expect(dhcpConf.leaseTime).toBe(7200);
  });

  test('named.conf.local + db 文件：zone→db 与 A 记录（@ → apex）', () => {
    const zoneEntries = parseNamedConfLocal('zone "lab.local" {\n  type master;\n  file "/etc/bind/db.lab";\n};\n');
    expect(zoneEntries).toHaveLength(1);
    expect(zoneEntries[0]!.db).toBe('/etc/bind/db.lab');
    const db = parseDbFile('www IN A 10.0.0.7\n@ IN A 10.0.0.1\n', 'lab.local');
    expect(db['www.lab.local']).toBe('10.0.0.7');
    expect(db['lab.local']).toBe('10.0.0.1');
  });

  test('apache vhost：ServerName/DocumentRoot', () => {
    const apacheConf = parseApacheVhost('<VirtualHost *:80>\n  ServerName www.lab.local\n  DocumentRoot /srv/www\n</VirtualHost>\n');
    expect(apacheConf.vhosts[0]).toBe('www.lab.local');
    expect(apacheConf.documentRoot).toBe('/srv/www');
  });
});

describe('解析结果落 store → 引擎闭环', () => {
  test('dhcpd.conf 驱动 DORA：按解析池分配 + 按租约时间落盘', async () => {
    const { pc0, server } = setup();
    const st = useStore.getState();
    const cur = dev(server);
    const poolCfg = parseDhcpdConf('subnet 192.168.1.0 netmask 255.255.255.0 { range 192.168.1.150 192.168.1.160; default-lease-time 7200; }');
    const pool: DhcpdConfig = {
      rangeStart: poolCfg.rangeStart,
      rangeEnd: poolCfg.rangeEnd,
      leaseTime: poolCfg.leaseTime ?? 3600,
      gateway: poolCfg.gateway ?? '192.168.1.1',
      dns: poolCfg.dns ?? '192.168.1.1',
      netmask: poolCfg.netmask ?? '255.255.255.0',
      listenInterfaces: cur.dhcpPool?.listenInterfaces ?? ['enp0s3'],
    };
    st.updateDevice(server, {
      dhcpPool: pool,
      services: { ...cur.services, dhcpd: { enabled: true, config: pool } },
    });

    const engine = new SimulationEngine(ctx);
    void engine.dhcpDora(pc0, server);
    const events = await drain(engine);
    const ackPkts = typedPackets(events, (p) => dhcpLayer(p)?.messageType === 'ack');
    expect(ackPkts).toHaveLength(1);
    expect(dhcpLayer(ackPkts[0]!)!.yiaddr).toBe('192.168.1.150'); // yiaddr 落在解析配置的池内
    expect(dev(server).dhcpLeases?.[0]!.expiresAt).toBeGreaterThan(Date.now() + 7000 * 1000); // default-lease-time 7200s
    expect(engine.isIdle()).toBe(true);
  });
});
