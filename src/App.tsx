// 原型阶段直接渲染 Ant Design 原型（WF-9）。
// 真实界面由 WF-4（画布）/ WF-9（设计系统）/ WF-5（可视化）落地后替换本文件。
// i18n 已在 main.tsx 通过 './i18n' 初始化（WF-8 抽取文案时使用）。
import AppPrototype from './prototype/AppPrototype';

export default function App() {
  return <AppPrototype />;
}
