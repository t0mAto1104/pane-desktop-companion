const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 590, height: 400, x: 90, y: 95, backgroundColor: '#318654', title: 'Pane 纸上交易验收', webPreferences: { backgroundThrottling: false, enableBlinkFeatures: 'UiaProvider' } });
  const html = `<meta charset="utf-8"><title>Pane 纸上交易验收</title>
    <body style="font:18px Segoe UI,sans-serif;background:#318654;color:white;margin:0;padding:74px 95px">
    <h1 style="margin:0">纸上交易 · DEMO</h1><p>SIM-101　价格 125.40　持仓 10</p>
    <code>账户为测试夹具，所有数据均为模拟。</code><div style="margin-top:16px"><button id="open-long">买入开仓</button> <button id="close-order">平仓</button> <button>查看详情</button> <button>查看详情</button></div><input aria-label="测试密码" type="password" value="PRIVATE_FIXTURE_VALUE">`;
  app.setAccessibilitySupportEnabled(true);
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await window.webContents.executeJavaScript(`window.paneFixtureOrderClicks = 0;
    for (const id of ['open-long', 'close-order']) document.getElementById(id).addEventListener('click', () => window.paneFixtureOrderClicks++);`);
  window.show();
  window.focus();
});
app.on('window-all-closed', () => app.quit());
