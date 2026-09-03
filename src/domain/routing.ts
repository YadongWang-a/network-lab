/**
 * 拓扑级路由自动生成（WF-7）：拓扑变更 → 自动计算并写回各路由器路由表。
 *
 * 设计约定：
 * - 纯函数模块，不依赖 store/React（可直接单测，对齐 WF-12）；确定性输出
 *   （节点/邻居/目标全排序 + 固定 tie-break），重复计算同一拓扑结果一致。
 * - 算法继承 legacy `dynamic_routing_lib` 的思路：以「网络段」为图节点、路由器为段间
 *   桥，Dijkstra 求最短跳数路径，next-hop = 对端路由器在共享网段上的接口 IP。
 * - 关键差异（拓扑感知）：legacy `getNodes` 只扫路由器接口的 IP 子网、不看线缆；
 *   WF-6 自动分配会让每台路由器在默认三网段上都有接口 → 所有子网"直连"可见、
 *   远端路由永远算不出来。本模块只把 **已连线（connection 存在）且配置了 IP** 的
 *   路由器接口纳入网段图：节点 = (交换机, 子网)，同一交换机同子网的多台路由器
 *   互为 on-link 对等体，不同交换机的同名子网不互通。拓扑连通才产生路由，
 *   断线/删设备/IP 变更后整表重算，符合「拓扑连通即通、无需手填路由」。
 * - 直连路由一并生成（nextHop `0.0.0.0` = 直连）；远端路由 next-hop 必然落在
 *   本路由器某直连网段上（由路径起点网段保证，on-link 校验成为构造性成立）。
 * - 收尾沿用 legacy `groupByDefaultRules`：同一 next-hop 的远端条目 >1 条时
 *   收拢为该 next-hop 的一条 `0.0.0.0/0.0.0.0` 默认路由（其余条目保留为显式路由；
 *   仅 1 条远端时不收拢，保持显式）。0.0.0.0/0 前缀最短，不影响最长前缀匹配。
 */
import type { DeviceId, IPv4, RoutingTableEntry, Topology } from './types';
import { ipToInt, networkOf } from './ipam';

/** 网段图上某台路由器接入该网段的接口快照。 */
interface SegmentMember {
  routerId: DeviceId;
  ifaceId: string;
  ip: IPv4;
  netmask: IPv4;
  network: IPv4;
}

interface Segment {
  /** 首个成员的掩码（同一交换机同子网误配多掩码时取成员序首个，仅作目标掩码用）。 */
  netmask: IPv4;
  members: SegmentMember[];
}

/**
 * 收集网段图：交换机上「已连线 + 有 IP」的路由器接口构成网段节点。
 * 节点键 = `交换机id::子网地址`（同交换机同子网 ⇒ 同一 L2 网段 / on-link 对等体）。
 */
function collectSegments(topology: Topology): Map<string, Segment> {
  const { devices, connections } = topology;
  const connected = new Map<string, string>(); // `设备id::接口id` → 所连交换机
  for (const c of connections) {
    if (devices[c.fromDeviceId]?.interfaces[c.fromInterfaceId] && devices[c.toSwitchId]) {
      connected.set(`${c.fromDeviceId}::${c.fromInterfaceId}`, c.toSwitchId);
    }
  }
  const segments = new Map<string, Segment>();
  for (const dev of Object.values(devices)) {
    if (!dev.ipv4Forwarding) continue;
    for (const ifaceId of Object.keys(dev.interfaces).sort()) {
      const iface = dev.interfaces[ifaceId];
      const toSwitch = connected.get(`${dev.id}::${ifaceId}`);
      if (!toSwitch || !iface.ip || !iface.netmask) continue;
      const network = networkOf(iface.ip, iface.netmask);
      const key = `${toSwitch}::${network}`;
      let seg = segments.get(key);
      if (!seg) {
        seg = { netmask: iface.netmask, members: [] };
        segments.set(key, seg);
      }
      seg.members.push({ routerId: dev.id, ifaceId, ip: iface.ip, netmask: iface.netmask, network });
    }
  }
  // 规范化：段成员按 (routerId, ifaceId) 排序（canonical 掩码 = 首成员）—— 确定性。
  for (const seg of segments.values()) {
    seg.members.sort((a, b) =>
      a.routerId === b.routerId ? a.ifaceId.localeCompare(b.ifaceId) : a.routerId.localeCompare(b.routerId),
    );
  }
  return segments;
}

/** 路由器 → 其接入的网段键（排序去重；路由器 = 段间桥）。 */
function routerKeysOf(segments: Map<string, Segment>): Map<DeviceId, string[]> {
  const routerKeys = new Map<DeviceId, string[]>();
  for (const [key, seg] of segments) {
    for (const m of seg.members) {
      const list = routerKeys.get(m.routerId) ?? [];
      if (list[list.length - 1] !== key) list.push(key);
      routerKeys.set(m.routerId, list);
    }
  }
  for (const list of routerKeys.values()) list.sort();
  return routerKeys;
}

/**
 * 段间邻接表 + 每对网段的桥接路由器集合：同一条边上可能有多台路由器都同时接入两端
 * （冗余网关），取 routerId 最小者作确定性 next-hop 来源。
 */
function buildGraph(segments: Map<string, Segment>): {
  adj: Map<string, string[]>;
  bridges: Map<string, DeviceId>;
} {
  const adj = new Map<string, string[]>();
  const bridges = new Map<string, DeviceId>();
  for (const [routerId, keys] of routerKeysOf(segments)) {
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const a = keys[i] < keys[j] ? keys[i] : keys[j];
        const b = keys[i] < keys[j] ? keys[j] : keys[i];
        const pairKey = `${a}|${b}`;
        const prev = bridges.get(pairKey);
        if (prev === undefined || prev > routerId) bridges.set(pairKey, routerId);
        for (const u of [a, b]) {
          const list = adj.get(u) ?? [];
          const v = u === a ? b : a;
          if (list[list.length - 1] !== v) list.push(v);
          adj.set(u, list);
        }
      }
    }
  }
  for (const list of adj.values()) list.sort();
  return { adj, bridges };
}

/**
 * 多点源 Dijkstra（跳数 = 边权 1）：从 `sources` 出发到全图的最短路径。
 * 源点 prev 为 null；同距离按节点键字典序稳定取前驱（确定性）。
 */
function dijkstra(
  allKeys: string[],
  adj: Map<string, string[]>,
  sources: ReadonlySet<string>,
): { prev: Map<string, string | null>; dist: Map<string, number> } {
  const dist = new Map<string, number>(allKeys.map((key) => [key, Number.POSITIVE_INFINITY]));
  const prev = new Map<string, string | null>(allKeys.map((key) => [key, null]));
  for (const s of sources) dist.set(s, 0);
  const unvisited = new Set(allKeys);
  while (unvisited.size > 0) {
    let cur: string | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const key of unvisited) {
      const d = dist.get(key) ?? Number.POSITIVE_INFINITY;
      if (d < best || (d === best && (cur === null || key < cur))) {
        best = d;
        cur = key;
      }
    }
    if (cur === null || best === Number.POSITIVE_INFINITY) break;
    unvisited.delete(cur);
    for (const nb of adj.get(cur) ?? []) {
      if (!unvisited.has(nb)) continue;
      if (best + 1 < (dist.get(nb) ?? Number.POSITIVE_INFINITY)) {
        dist.set(nb, best + 1);
        prev.set(nb, cur);
      }
    }
  }
  return { prev, dist };
}

/**
 * 计算全拓扑的路由器路由表：直连路由（已连线接口的子网）+ 经 Dijkstra 的远端路由
 * （默认路由收拢见模块注释）。返回 设备id → 路由表；所有开启转发的路由器都在结果中
 * （无远端路由时为仅直连/空表，供调用方整体覆盖，清掉断线残留的陈旧条目）。
 */
export function computeRouterRoutingTables(topology: Topology): Record<DeviceId, RoutingTableEntry[]> {
  // 所有开启转发的设备都进结果（默认空表）：整体覆盖式写回，断线/删设备后清掉陈旧条目。
  const tables: Record<DeviceId, RoutingTableEntry[]> = {};
  for (const dev of Object.values(topology.devices)) {
    if (dev.ipv4Forwarding) tables[dev.id] = [];
  }
  const segments = collectSegments(topology);
  if (segments.size === 0) return tables;

  const { adj, bridges } = buildGraph(segments);
  const allKeys = [...segments.keys()].sort();
  const routerKeys = routerKeysOf(segments);

  for (const [routerId, keys] of routerKeys) {
    // —— 直连路由：已连线且有 IP 的接口，按 (network, netmask) 去重、按子网/接口排序 ——
    const direct: RoutingTableEntry[] = [];
    const directSeen = new Set<string>();
    for (const key of keys) {
      for (const m of segments.get(key)!.members) {
        if (m.routerId !== routerId) continue;
        const dedupe = `${m.network}::${m.netmask}`;
        if (directSeen.has(dedupe)) continue;
        directSeen.add(dedupe);
        direct.push({ network: m.network, netmask: m.netmask, interfaceId: m.ifaceId, nextHop: '0.0.0.0' });
      }
    }
    direct.sort((a, b) =>
      ipToInt(a.network) === ipToInt(b.network)
        ? a.interfaceId.localeCompare(b.interfaceId)
        : ipToInt(a.network) - ipToInt(b.network),
    );

    // —— 远端路由：目标 = 其它路由器接入的网段（同子网跨交换机视为已直连，跳过）——
    const ownNetworks = new Set<string>();
    for (const key of keys) {
      for (const m of segments.get(key)!.members) {
        if (m.routerId === routerId) ownNetworks.add(m.network);
      }
    }
    const sources = new Set(keys);
    const { prev, dist } = dijkstra(allKeys, adj, sources);
    const remote: RoutingTableEntry[] = [];
    const remoteSeen = new Set<string>();
    const targets = allKeys
      .filter((key) => {
        const seg = segments.get(key)!;
        return seg.members.some((m) => m.routerId !== routerId) && !ownNetworks.has(seg.members[0].network);
      })
      .sort((a, b) => {
        const na = ipToInt(segments.get(a)!.members[0].network);
        const nb = ipToInt(segments.get(b)!.members[0].network);
        return na === nb ? a.localeCompare(b) : na - nb;
      });
    for (const targetKey of targets) {
      if (!Number.isFinite(dist.get(targetKey) ?? Number.POSITIVE_INFINITY)) continue;
      // 还原路径 → 起点 egress 段 e* = prev 链尽头（必为本路由器源段）。
      const path: string[] = [];
      let cur: string | null = targetKey;
      while (cur !== null) {
        path.unshift(cur);
        cur = prev.get(cur) ?? null;
      }
      if (path.length < 2) continue;
      const egressKey = path[0];
      const nextKey = path[1];
      if (!sources.has(egressKey)) continue; // 防御：起点非本路由器网段
      const egress = segments.get(egressKey)!.members.find((m) => m.routerId === routerId);
      const [ua, ub] = egressKey < nextKey ? [egressKey, nextKey] : [nextKey, egressKey];
      const bridge = bridges.get(`${ua}|${ub}`);
      if (!egress || bridge === undefined) continue;
      // next-hop = 桥接 (egress → next) 的路由器在 egress 网段上的接口 IP（on-link 构造性成立）。
      const hop = segments.get(egressKey)!.members.find((m) => m.routerId === bridge);
      if (!hop) continue;
      const targetSeg = segments.get(targetKey)!;
      const row: RoutingTableEntry = {
        network: targetSeg.members[0].network,
        netmask: targetSeg.netmask,
        interfaceId: egress.ifaceId,
        nextHop: hop.ip,
      };
      const dedupe = `${row.network}::${row.netmask}`;
      if (!remoteSeen.has(dedupe)) {
        remoteSeen.add(dedupe);
        remote.push(row);
      }
    }
    remote.sort((a, b) =>
      ipToInt(a.network) === ipToInt(b.network)
        ? ipToInt(a.netmask) - ipToInt(b.netmask)
        : ipToInt(a.network) - ipToInt(b.network),
    );

    // —— 默认路由收拢（同 next-hop 远端条目 >1 时收成 0.0.0.0/0，legacy groupByDefaultRules）——
    let condensed = remote;
    if (remote.length > 1) {
      const count = new Map<string, { n: number; iface: string }>();
      for (const row of remote) {
        const rec = count.get(row.nextHop);
        if (rec) rec.n += 1;
        else count.set(row.nextHop, { n: 1, iface: row.interfaceId });
      }
      let best: string | null = null;
      let bestCount = 1;
      for (const [hop, rec] of count) {
        if (rec.n > bestCount || (rec.n === bestCount && best !== null && ipToInt(hop) < ipToInt(best))) {
          best = hop;
          bestCount = rec.n;
        }
      }
      if (best !== null && bestCount > 1) {
        const rest = remote.filter((row) => row.nextHop !== best);
        rest.push({ network: '0.0.0.0', netmask: '0.0.0.0', interfaceId: count.get(best)!.iface, nextHop: best });
        condensed = rest;
      }
    }

    tables[routerId] = [...direct, ...condensed];
  }
  return tables;
}
