const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 590, height: 400, x: 90, y: 95, backgroundColor: '#318654', title: 'Pane 纸上交易验收' });
  const html = `<meta charset="utf-8"><title>Pane 纸上交易验收</title>
    <body style="font:18px Segoe UI,sans-serif;background:#318654;color:white;margin:0;padding:74px 95px">
    <h1 style="margin:0">纸上交易 · DEMO</h1><p>SIM-101　价格 125.40　持仓 10</p>
    <code>账户为测试夹具，所有数据均为模拟。</code>`;
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  window.show();
  window.focus();
});
app.on('window-all-closed', () => app.quit());
