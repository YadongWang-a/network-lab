import React from 'react';
import ReactDOM from 'react-dom/client';
// i18n 必须先于组件模块求值初始化（WF-8），否则模块级 i18n.t 取不到译文。
import './i18n';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
