function monitorCalendarAggregation() {
  const props = PropertiesService.getScriptProperties();

  // 監視対象でなければ何もしない
  if (props.getProperty('ocr_monitor_enabled') !== '1') {
    Logger.log('監視対象なし。終了');
    stopMonitorTrigger();
    return;
  }

  const status = props.getProperty('ocr_status');
  const lastBeat = Number(props.getProperty('ocr_last_heartbeat') || 0);
  const now = Date.now();

  Logger.log(`監視チェック: status=${status}`);

  // ===== 正常完了 =====
  if (status === 'completed') {
    Logger.log('✅ 集計完了を検知。監視終了');
    stopMonitorTrigger();
    return;
  }

  // ===== タイムアウト判定 =====
  const TIMEOUT = 30 * 60 * 1000; // 30分無応答
  if (now - lastBeat > TIMEOUT) {
    Logger.log('⚠️ タイムアウト検知。myFunction を再実行');

    // 再実行トリガー
    ScriptApp.newTrigger('myFunction')
      .timeBased()
      .after(5 * 1000)
      .create();

    // heartbeat 更新（連続起動防止）
    props.setProperty('ocr_last_heartbeat', String(now));
  }
}

function startMonitor() {
  stopMonitorTrigger(); // 二重防止

  ScriptApp.newTrigger('monitorCalendarAggregation')
    .timeBased()
    .everyMinutes(10)
    .create();

  Logger.log('👀 監視トリガー開始');
}

function stopMonitorTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'monitorCalendarAggregation') {
      ScriptApp.deleteTrigger(t);
    }
  });
}
