/**
 * WF-12 最小冒烟 E2E：四条主流程 ——
 * 1. 加载即中文 UI（顶栏/演示命令/报文追踪/画布/设备图标条）
 * 2. 拖入设备 → IPAM 自动配置上牌 → 拉线（设备→交换机）
 * 3. 种子拓扑上演示 ping（PC-0→PC-1）→ 追踪行 + 报文动画
 * 4. 设备终端：打开窗口执行 ip addr
 */
import { expect, test, type Page } from '@playwright/test';

/** 面板图标（img alt = 面板 key）。 */
function panelTile(page: Page, key: string) {
  return page.locator(`img[alt="${key}"]`);
}

/** 清掉挂载种子拓扑（新建拓扑按钮），得到空画布。 */
async function freshBoard(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '新建拓扑' }).click();
  await expect(page.locator('.dev-name')).toHaveCount(0);
}

/** HTML5 拖放：dragstart 带真实 DataTransfer 派发到画布；clientX/Y 决定设备落点。 */
async function dropDevice(page: Page, key: string, x: number, y: number) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await panelTile(page, key).dispatchEvent('dragstart', { dataTransfer });
  await page.locator('.react-flow').dispatchEvent('drop', { dataTransfer, clientX: x, clientY: y });
}

/** 从 A 节点顶部连接手柄拖到 B 节点（React Flow onConnect；WF-15 强制设备→交换机）。 */
async function connectNodes(page: Page, nodeA: string, nodeB: string) {
  const a = page.locator('.react-flow__node').filter({ has: page.locator(`.dev-name:text-is("${nodeA}")`) });
  const b = page.locator('.react-flow__node').filter({ has: page.locator(`.dev-name:text-is("${nodeB}")`) });
  const aBox = (await a.boundingBox())!;
  const bBox = (await b.boundingBox())!;
  await page.mouse.move(aBox.x + aBox.width / 2, aBox.y + aBox.height / 2); // hover 触发手柄显示
  await page.mouse.move(aBox.x + aBox.width / 2, aBox.y, { steps: 3 }); // 移到顶部手柄中心
  await page.mouse.down();
  await page.mouse.move(bBox.x + bBox.width / 2, bBox.y + bBox.height / 2, { steps: 10 });
  await page.mouse.up();
}

test('加载即中文 UI：顶栏、演示命令、画布、报文追踪', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('PackeTTrino 网络模拟器')).toBeVisible();
  await expect(page.getByText('演示命令')).toBeVisible();
  await expect(page.getByText('报文追踪')).toBeVisible();
  await expect(page.locator('.react-flow')).toBeVisible();
  await expect(panelTile(page, 'pc')).toBeVisible(); // 设备图标条可见
});

test('拖入设备：三节点上画布 + IPAM 自动配置 + 拉线入交换机', async ({ page }) => {
  await freshBoard(page);
  await dropDevice(page, 'pc', 400, 250);
  await dropDevice(page, 'switch', 550, 250);
  await dropDevice(page, 'pc', 700, 250);

  await expect(page.locator('.dev-name')).toHaveCount(3);
  await expect(page.locator('.dev-ip')).toHaveCount(2); // 交换机无 IP
  await expect(page.locator('.dev-ip').first()).toHaveText(/^192\.168\.1\.\d+$/); // 默认子网池

  const names = await page.locator('.dev-name').allTextContents();
  await connectNodes(page, names[0]!, names[1]!); // 设备→交换机（WF-15 强制语义）
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
});

/** antd Select 选项：按 combobox 的 aria-controls 绑定其专属下拉，避开隐藏下拉干扰。 */
async function pickOption(page: Page, comboIdx: number, label: string) {
  const combo = page.getByRole('combobox').nth(comboIdx); // 面板顺序：命令类型 / 源 / 目标
  await combo.click();
  const ddId = await combo.getAttribute('aria-controls');
  // aria-controls 指向 0 高的虚拟列表包裹层，Playwright 视为 hidden —— 锚到可见的 dropdown 容器
  const dd = page.locator(`.ant-select-dropdown:has([id="${ddId}"])`);
  await expect(dd).toBeVisible();
  await dd.locator('.ant-select-item-option').filter({ hasText: label }).first().click();
  await expect(dd).toBeHidden({ timeout: 10_000 });
}

test('演示 ping（种子拓扑 PC-0→PC-1）：追踪行 + 报文动画', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await pickOption(page, 1, 'PC-0');
  await pickOption(page, 2, 'PC-1');
  // 动画帧是瞬态的：先挂等待，再触发演示
  const dotSeen = page.locator('.viz-dot').first().waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByRole('button', { name: '开始' }).click();
  await dotSeen;

  // 追踪行 = 每逻辑报文一行：ARP req/rep + ICMP req/rep
  await expect(page.locator('.ant-list-item').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.ant-list-item')).toHaveCount(4, { timeout: 15_000 });
  await expect(page.locator('.ant-list-item').first()).toContainText('ARP');

  // WF-20 包解剖：点第一行 → 追踪面板下方内联展示层条 + hex（无对话框）
  await page.locator('.ant-list-item').first().click();
  await expect(page.getByText('以太网帧')).toBeVisible();
  await expect(page.getByText('原始字节')).toBeVisible();
  await expect(page.getByText(/1 \(request\)/)).toBeVisible(); // 字段表 ARP 说明口径
});

test('设备终端：打开窗口并执行 ip addr', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.dev-name').first()).toBeVisible(); // 种子拓扑 PC-0
  const box = (await page.locator('img[alt="PC 主机"]').first().boundingBox())!; // 节点图标
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); // 悬停触发操作按钮
  await page.waitForTimeout(200);
  await page.locator('button:has(.anticon-code)').first().click();
  await expect(page.getByText(/终端已连接/)).toBeVisible();
  await page.keyboard.type('ip addr');
  await page.keyboard.press('Enter');
  await expect(page.getByText(/inet 192\.168\.1\./)).toBeVisible({ timeout: 5_000 });
});
