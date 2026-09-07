// 应用壳：直接渲染正式界面（WF-18：原型文件升格为 src/ui/App.tsx，去掉 Prototype 别名）。
// i18n 已在 main.tsx 通过 './i18n' 初始化（WF-8 抽取文案时使用）。
import AppView from './ui/App';

export default function App() {
  return <AppView />;
}
