/**
 * 设备虚拟文件系统（WF-11 终端命令底层）：纯函数操作 `Device.filesystem` 树。
 * 树形状（WF-2）：`FilesystemNode` = `Record<name, FilesystemNode | string>`，
 * 目录为对象、文件为字符串；存储时含根键 `'/'`（见 deviceFactory BASE_FILESYSTEM）。
 *
 * 所有操作返回新树（不变式），错误信息中文（终端直出，不做 UI chrome i18n）。
 */

import type { FilesystemNode } from './types';

export type FsEntry = { path: string[]; node: FilesystemNode | string };

/** 相对/绝对路径 → 段数组（相对基于 cwd 段数组解析；.. 折叠；/ 开头为绝对）。 */
export function resolveSegments(input: string, cwd: string[]): string[] {
  const parts = input.startsWith('/')
    ? input.split('/').filter(Boolean)
    : [...cwd, ...input.split('/').filter(Boolean)];
  const out: string[] = [];
  for (const p of parts) {
    if (p === '.' || p === '') continue;
    if (p === '..') {
      out.pop();
      continue;
    }
    out.push(p);
  }
  return out;
}

/** 根节点（含 '/' 键）。 */
function rootOf(tree: FilesystemNode): FilesystemNode | undefined {
  return typeof tree['/'] === 'object' && tree['/'] !== null ? (tree['/'] as FilesystemNode) : undefined;
}

/** 定位目录节点：不存在返回 null。 */
function dirAt(tree: FilesystemNode, dir: string[]): FilesystemNode | null {
  let cur = rootOf(tree);
  if (!cur) return null;
  for (const seg of dir) {
    const next = cur[seg];
    if (typeof next !== 'object' || next === null) return null;
    cur = next as FilesystemNode;
  }
  return cur;
}

/** 目录是否存在（cd 校验用）。 */
export function dirExists(tree: FilesystemNode, dir: string[]): boolean {
  return dirAt(tree, dir) !== null;
}

/** 树深拷（写时复制前复制整棵子树代价高，这里按需对路径段复制）。 */
function cloneDir(node: FilesystemNode): FilesystemNode {
  const out: FilesystemNode = {};
  for (const [k, v] of Object.entries(node)) out[k] = v;
  return out;
}

/** 沿路径复制目录链返回「新的顶层树」。路径中每个目录都换新对象，mutate 就地改末目录。 */
function withDir(tree: FilesystemNode, dir: string[], mutate: (dirNode: FilesystemNode) => void): FilesystemNode {
  const root = rootOf(tree);
  if (!root) return tree;
  const newRoot = cloneDir(root);
  let cur = newRoot;
  for (const seg of dir) {
    const next = cur[seg];
    if (typeof next !== 'object' || next === null) return tree; // 路径不存在 → 原样
    const copy = cloneDir(next as FilesystemNode);
    cur[seg] = copy;
    cur = copy;
  }
  mutate(cur);
  return { '/': newRoot };
}

/** 列出目录（含相对路径解析）；目录名后带 '/'，文件不带。 */
export function fsLs(tree: FilesystemNode, path: string, cwd: string[]): string {
  const segs = resolveSegments(path || '.', cwd);
  const dir = dirAt(tree, segs);
  if (!dir) throw new Error(`ls: 无法访问 '${path || '.'}': 目录不存在`);
  const names = Object.keys(dir).sort();
  return names.map((n) => (typeof dir[n] === 'object' && dir[n] !== null ? `${n}/` : n)).join('  ');
}

/** 读取文件内容；路径是目录时报错。 */
export function fsRead(tree: FilesystemNode, path: string, cwd: string[]): string {
  const segs = resolveSegments(path, cwd);
  const fileName = segs.pop();
  if (!fileName) throw new Error(`cat: '${path}': 是目录`);
  const dir = dirAt(tree, segs);
  const val = dir ? dir[fileName] : undefined;
  if (typeof val !== 'string') throw new Error(`cat: '${path}': 文件不存在`);
  return val;
}

/** 写文件（覆盖）；目录不存在自动报错。 */
export function fsWrite(tree: FilesystemNode, path: string, content: string, cwd: string[]): FilesystemNode {
  const segs = resolveSegments(path, cwd);
  const fileName = segs.pop();
  if (!fileName) throw new Error(`写文件失败：'${path}' 无文件名`);
  if (!dirAt(tree, segs)) throw new Error(`写文件失败：目录 ${segs.join('/') || '/'} 不存在`);
  return withDir(tree, segs, (d) => {
    d[fileName] = content;
  });
}

/** 追加写文件（不存在则创建）。 */
export function fsAppend(tree: FilesystemNode, path: string, content: string, cwd: string[]): FilesystemNode {
  const existing = safeRead(tree, path, cwd);
  return fsWrite(tree, path, existing ? `${existing}${content}` : content, cwd);
}

/** 读文件，不存在返回 ''（不抛错）。 */
function safeRead(tree: FilesystemNode, path: string, cwd: string[]): string {
  try {
    return fsRead(tree, path, cwd);
  } catch {
    return '';
  }
}

/** 建目录（含中间目录）。 */
export function fsMkdir(tree: FilesystemNode, path: string, cwd: string[]): FilesystemNode {
  const segs = resolveSegments(path, cwd);
  if (segs.length === 0) throw new Error('mkdir: 无效路径');
  const name = segs.pop()!;
  if (dirAt(tree, segs) && dirAt(tree, [...segs, name])) throw new Error(`mkdir: 目录已存在：${name}`);
  if (!dirAt(tree, segs)) throw new Error(`mkdir: 无法创建：目录 ${segs.join('/') || '/'} 不存在`);
  return withDir(tree, segs, (d) => {
    d[name] = {};
  });
}

/** 建空文件（已存在则不报错，同 touch）。 */
export function fsTouch(tree: FilesystemNode, path: string, cwd: string[]): FilesystemNode {
  const segs = resolveSegments(path, cwd);
  const name = segs.pop();
  if (!name) throw new Error('touch: 无效路径');
  if (!dirAt(tree, segs)) throw new Error(`touch: 目录不存在：${segs.join('/') || '/'}`);
  const existing = dirAt(tree, [...segs, name]);
  if (typeof existing === 'string' || (existing && typeof existing === 'object')) return tree; // 已存在
  return withDir(tree, segs, (d) => {
    d[name] = '';
  });
}

/** 删除路径（文件或空目录；目录非空抛错）。 */
export function fsRm(tree: FilesystemNode, path: string, recursive: boolean, cwd: string[]): FilesystemNode {
  const segs = resolveSegments(path, cwd);
  const name = segs.pop();
  if (!name) throw new Error('rm: 无效路径');
  const dir = dirAt(tree, segs);
  const val = dir ? dir[name] : undefined;
  if (val === undefined) throw new Error(`rm: 无法删除 '${path}': 不存在`);
  if (!recursive && typeof val === 'object' && val !== null && Object.keys(val).length > 0) {
    throw new Error(`rm: 无法删除 '${path}': 目录非空（用 rm -r）`);
  }
  if (!dir) return tree;
  return withDir(tree, segs, (d) => {
    delete d[name];
  });
}

/** 移动/复制。src、dst 均为文件或（cp 目录）路径。 */
export function fsMoveCopy(
  tree: FilesystemNode,
  src: string,
  dst: string,
  copy: boolean,
  cwd: string[],
): FilesystemNode {
  const sSegs = resolveSegments(src, cwd);
  const sName = sSegs.pop()!;
  const sDir = dirAt(tree, sSegs);
  const srcVal = sDir ? sDir[sName] : undefined;
  if (srcVal === undefined) throw new Error(`${copy ? 'cp' : 'mv'}: 无法访问 '${src}': 不存在`);

  const dSegs = resolveSegments(dst, cwd);
  const dName = dSegs.pop()!;
  if (!dirAt(tree, dSegs)) throw new Error(`${copy ? 'cp' : 'mv'}: 目标目录不存在`);
  // 目标为已存在目录 → 移入其下同名
  const existingDir = dirAt(tree, dSegs) ? dirAt(tree, [...dSegs, dName]) : null;
  let finalName = dName;
  let finalDir = dSegs;
  if (existingDir && typeof existingDir === 'object' && existingDir !== null) {
    finalDir = [...dSegs, dName];
    finalName = sName;
  }
  if (copy && typeof srcVal === 'object' && srcVal !== null) {
    throw new Error(`cp: 暂不支持复制目录：'${src}'`);
  }
  if (finalDir.join('/') === sSegs.join('/') && finalName === sName) return tree; // 同路径
  let next = tree;
  if (copy) {
    next = withDir(next, finalDir, (d) => {
      d[finalName] = srcVal as string;
    });
    return next;
  }
  // mv：目标先写再删源（同树内安全）
  next = withDir(next, finalDir, (d) => {
    d[finalName] = srcVal;
  });
  next = withDir(next, sSegs, (d) => {
    delete d[sName];
  });
  return next;
}
