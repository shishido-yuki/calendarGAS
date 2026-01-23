var INTERNAL_DOMAINS = ['moneyforward.co.jp', 'mfkessai.co.jp', 'bizforward.co.jp', 'moneyforwardhome.co.jp', 'i.moneyforward.com']; // 必要に応じて編集
var RESOURCE_DOMAINS = ['resource.calendar.google.com'];
var SPREAD_SHEET_ID = '1RsQXhvBYMZe1MsOjsxSpfr6Gr-zy_0dpSSwR1siYVbo'; // 必要に応じて置換
var SPREAD_JOB_ID = '1Ovp7i0_Jj6AERVnD3miGLm4zKT1IB_hEoXs_omEvMGI'; //社員一覧
var GROUP_SHEET_ID = '1UnPJ7aCToioQJL3X80WjOSSwJZ8dU0XWwK49cQL6Fko';//グループアドレスリスト 必要に応じて置換
var ROOT_FOLDER_NAME = 'ミーティング時間集計';
var EVENT_FOLDER_NAME = 'イベントCSV';
var PREFIX = 'calendar_events_';            // 対象CSVの名前プレフィックス
var FIXED_FROM_DATE = null;
var FIXED_TO_DATE = null;
//指定日付の場合はこちらを使用
//FIXED_FROM_DATE = new Date(2025,(9-1),1); //必要ならコメントアウトを外して使用
//FIXED_TO_DATE = new Date(2025,(10-1),1);  //必要ならコメントアウトを外して使用
//デフォルト期間前月
var range = getTargetDateRange();
var FIXED_FROM_DATE = range.from;
var FIXED_TO_DATE   = range.to;

// 年と月を取得
var year = FIXED_FROM_DATE.getFullYear();
var month = FIXED_FROM_DATE.getMonth() + 1; // 0始まりなので +1

// フォルダ名を作成
var FOLDER_NAME = year + "年" + month + "月";


// ログ頻度・バッチ設定（必要ならここを編集）
var LOG_EVERY = 20; // 何件ごとにログ出すか
var CHUNK_SIZE = 50; // 1回の実行で処理するユニークメール数（環境に合わせて調整）

function myFunction() {
  // 0) ログ出力
  var props = PropertiesService.getScriptProperties();
  Logger.log('Script properties: ' + JSON.stringify(props.getProperties()));

  // ===== 監視用ステータス設定 =====
  props.setProperty('ocr_status', 'running');
  props.setProperty('ocr_last_heartbeat', String(Date.now()));
  props.setProperty('ocr_monitor_enabled', '1');
  startMonitor();//監視スタート

  
  // 1) メンバー読み込み → grouped を優先して再利用（2回目以降は grouped CSV を使う）
  var members = getMembers(props.getProperty('ocr_members_fileId'));
  var grouped = groupById(members);

  // 2) CSVを Drive に保存（グループ単位で出力）
  var exportTs = saveMembersCsv(props, grouped);
  
  // === 3) 初回チャンクなら職種を統合 ===
  var partIndex = Number(props.getProperty('ocr_part_index') || '1');
  if (partIndex === 1) {
    Logger.log('初回チャンクのため addJobTypeToLatestMemberCsv() を実行');
    addJobTypeToLatestMemberCsv();

    // CSVから jobType マップ作成
    var jobTypeMap = loadJobTypeMapFromLatestCsv(); // email -> jobType
  } else {
    var jobTypeMap = null; // 2回目以降は既存情報を利用
  }
  // 4) 代表リストを作成
  var representatives = pickRepresentativePerId(grouped, jobTypeMap);

  // 5) email -> id のマップを作成（参加者カウントを ID 単位で行うため）
  var emailIdMap = buildEmailToIdMap(members);
  var uniqueEmails = Object.keys(emailIdMap || {});

  Logger.log('全メンバー数: ' + members.length);
  Logger.log('グループ数 (ID): ' + Object.keys(grouped).length);
  Logger.log('メールリスト件数: ' + uniqueEmails.length);

  // 6) 日付範囲（過去1ヶ月）
  // var toDate = new Date();
  // var fromDate = new Date();
  // fromDate.setMonth(toDate.getMonth() - 1);
  var fromDate = FIXED_FROM_DATE;
  // var toDate = FIXED_TO_DATE.setHours(23, 59, 59, 999);
  var toDate = FIXED_TO_DATE;
  Logger.log('取得期間: %s ~ %s', fromDate.toISOString(), toDate.toISOString());

  // 7) 各代表のカレンダーを走査してイベント詳細を取得
  // emailIdMap のユニークなメールで回す（同一メールの重複処理を避ける）
  // バッチ処理: PropertiesService にカーソルを保存して途中再開可能にする
  var partIndex = Number(props.getProperty('ocr_part_index') || '1');
  var start = (partIndex - 1) * CHUNK_SIZE;
  var end = Math.min(uniqueEmails.length, start + CHUNK_SIZE);
  var groupMembersMap = loadGroupMembersMapFromSheet();
  var ge = getEvent(start, end, representatives, uniqueEmails, fromDate, toDate, emailIdMap,groupMembersMap);
  var detailsCache = ge.detailsCache || {};
  var emailReps = ge.emailReps || [];
  Logger.log(`処理対象のインデックス範囲:end = ${end}　`);

  // 8) カレンダー集計結果をCSVに出力（チャンクごとに part ファイルを作る）
  var outName = 'calendar_events_' + exportTs + '_part' + partIndex + '.csv';
  //var groupMembersMap = loadGroupMembersMapFromSheet();
  var file = safeRun(() =>exportCalendarEventsToDrive(emailReps, fromDate, toDate, emailIdMap, outName, null, detailsCache,groupMembersMap),3);

  // 9) 進捗を保存し、未完了なら再開トリガーを作成
  endLogic(end, props, uniqueEmails, partIndex, exportTs);
 }

// 日本語ヘッダマップ: メンバーCSV のキー -> 日本語ラベル
var MEMBER_HEADER_JP_MAP = {
  //orgId: '組織ID',
  company: '会社',
  org: '組織',
  hqOrOffice: '本部・拠点',
  department: '部署',
  groupOrUnit: 'グループ/ユニット',
  team: 'チーム',
  position: '役職',
  jobTitle: '職名',
  id: '社員ID',
  name: '氏名',
  email: 'メール',
  employmentType: '雇用形態',
  jobType:'職種',
  mainDuty: '主務',
  mainDutyInGCompany: 'G社主務',
  location: '勤務地'
};

// イベントCSV のキー -> 日本語ラベル
var EVENT_HEADER_JP_MAP = {
  repId: '代表ID',
  repName: '代表者名',
  repEmail: '代表メール',
  company: '会社',
  org: '組織',
  hqOrOffice: '本部・拠点',
  department: '部署',
  employmentType: '雇用形態',
  jobType:'職種',
  eventTitle: 'イベントタイトル',
  start: '開始',
  end: '終了',
  minutes: '分数',
  guestCount: '参加者数',
  organizer: 'オーガナイザー',
  hasExternalGuest: '社外フラグ',
  guestList: '参加者一覧',
  gueststatus: '参加者ステータス'

};

// 逆引き: 日本語ラベル -> 内部キー（aggregator/readers 用）
var JP_EVENT_HEADER_TO_KEY = {};
Object.keys(EVENT_HEADER_JP_MAP).forEach(function(k){ JP_EVENT_HEADER_TO_KEY[EVENT_HEADER_JP_MAP[k]] = k; });
var JP_MEMBER_HEADER_TO_KEY = {};
Object.keys(MEMBER_HEADER_JP_MAP).forEach(function(k){ JP_MEMBER_HEADER_TO_KEY[MEMBER_HEADER_JP_MAP[k]] = k; });
// グループID 列の日本語ラベル
JP_MEMBER_HEADER_TO_KEY['グループID'] = 'groupId';

function updateHeartbeat() {
  PropertiesService
    .getScriptProperties()
    .setProperty('ocr_last_heartbeat', String(Date.now()));
}
function markCompleted() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('ocr_status', 'completed');
  //props.setProperty('ocr_last_export_ts', exportTs);
  props.deleteProperty('ocr_monitor_enabled');
}


function clearAllScriptProperties() {
  var props = PropertiesService.getScriptProperties();
  Logger.log('Script properties: ' + JSON.stringify(props.getProperties()));
  props.deleteAllProperties();
  Logger.log('All script properties deleted.');
}

function setScriptProperties() {
  var props = PropertiesService.getScriptProperties();
  Logger.log('Script properties: ' + JSON.stringify(props.getProperties()));
  props.deleteAllProperties();
  // "ocr_part_index":"29","ocr_members_fileId":"1G1YNdi5T8-_gG5J4f7U4V-Z-6T9tectF"
  // props.setProperty("ocr_part_index","10");
  // props.setProperty("ocr_members_fileId","1kE5qpLbC8ik9Gw5TVS0u28TmpaCBFXVD");
  props.setProperty("ocr_last_export_ts", "20251006_120255");
  Logger.log('Script properties: ' + JSON.stringify(props.getProperties()));
}

function loadJobTypeMapFromLatestCsv() {
  var props = PropertiesService.getScriptProperties();
  var fileId = props.getProperty('ocr_members_fileId');
  if (!fileId) return {};

  try {
    var file = DriveApp.getFileById(fileId);
    var csvData = Utilities.parseCsv(file.getBlob().getDataAsString());
    if (csvData.length < 2) return {};
    
    var header = csvData[0].map(function(h){ return h.trim(); });
    var emailIdx = header.indexOf('メール');
    var jobTypeIdx = header.indexOf('職種');  
    if (emailIdx < 0 || jobTypeIdx < 0) return {};

    var map = {};
    for (var i = 1; i < csvData.length; i++) {
      var row = csvData[i];
      if (!row[emailIdx]) continue;
      map[row[emailIdx].trim().toLowerCase()] = row[jobTypeIdx] ? row[jobTypeIdx].trim() : '';
    }
    return map;

  } catch (e) {
    Logger.log('Failed to load members CSV: ' + e.toString());
    return {};
  }
}
/**
 * DefaultExports フォルダにある calendar_events_<ts>_part*.csv を集計して
 * 本部(hqOrOffice)・部(department)ごとに、社外の人の会議 / 1on1 / その他 の件数と合計時間を算出し CSV に出力する
 */
function aggregateCalendarEventPartsToSummary(exportTs) {

 // ROOT_FOLDER_NAME / FOLDER_NAME はメイン処理外側でセット済み
  let rootFolder;
  const rootFolders = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
  rootFolder = rootFolders.hasNext() ? rootFolders.next() : DriveApp.createFolder(ROOT_FOLDER_NAME);

  let monthFolder;
  const monthFolders = rootFolder.getFoldersByName(FOLDER_NAME);
  monthFolder = monthFolders.hasNext() ? monthFolders.next() : rootFolder.createFolder(FOLDER_NAME);

  let eventFolder;
  const eventFolders = monthFolder.getFoldersByName(EVENT_FOLDER_NAME);
  if (!eventFolders.hasNext()) {
    throw new Error(`イベントデータフォルダ "${EVENT_FOLDER_NAME}" が見つかりません`);
  }
  eventFolder = eventFolders.next();


  // ファイルパターン
  var pattern = new RegExp('^calendar_events_' + exportTs + '_part\\d+\\.csv$');
  var files = [];
  var fi = eventFolder.getFiles();
  while (fi.hasNext()) {
    var f = fi.next();
    if (pattern.test(f.getName())) files.push(f);
  }
  if (files.length === 0) {
    Logger.log('No calendar part files found for ts=' + exportTs);
  }

  // 集計マップ: key = company || org || hqOrOffice || department || employmentType || jobType
  var agg = {};

  // メンバー数をmember_<ts>.csvから取得
  var memberCounts = {};
  try {
    var memberPattern = new RegExp('^member_' + exportTs + '\\_\\d{6}\\.csv$|^member_' + exportTs + '\\.csv$');
    var mf = eventFolder.getFiles();
    while (mf.hasNext()) {
      var mfItem = mf.next();
      var mname = mfItem.getName();
      if (mname.indexOf('member_' + exportTs) === 0) {
        try {
          var mcContent = mfItem.getBlob().getDataAsString();
          var mlines = mcContent.split(/\r?\n/).filter(function(l){ return l !== ''; });
          if (mlines.length < 2) break;
          var mheader = parseCsvLine(mlines[0]);
          var midx = {};
          mheader.forEach(function(h, idx){
            var key = JP_MEMBER_HEADER_TO_KEY[h] || h;
            midx[key] = idx;
          });
          for (var mi = 1; mi < mlines.length; mi++) {
            var mrow = parseCsvLine(mlines[mi]);
            if (!mrow || mrow.length === 0) continue;
            var mcompany = mrow[midx['company']] || '';
            var morg = mrow[midx['org']] || '';
            var mhq = mrow[midx['hqOrOffice']] || '';
            var mdept = mrow[midx['department']] || '';
            var memType = mrow[midx['employmentType']] || '';
            var mjobType = mrow[midx['jobType']] || ''; // ★職種を追加
            var mkey = [mcompany, morg, mhq, mdept, memType, mjobType].join('||');
            memberCounts[mkey] = (memberCounts[mkey] || 0) + 1;
          }
        } catch (e) {
          Logger.log('Failed to parse member file ' + mname + ': ' + e.toString());
        }
      }
    }
  } catch (e) {
    Logger.log('Error reading member files for counts: ' + e.toString());
  }

  // --- 集計 ---
  files.forEach(function(f) {
    var content = f.getBlob().getDataAsString();
    var lines = content.split(/\r?\n/).filter(function(l){ return l !== ''; });
    if (lines.length < 2) return;

    var header = parseCsvLine(lines[0]);
    var idxMap = {};
    header.forEach(function(h, idx) {
      var key = JP_EVENT_HEADER_TO_KEY[h] || h;
      idxMap[key] = idx;
    });

    for (var i = 1; i < lines.length; i++) {
      var row = parseCsvLine(lines[i]);
      if (!row || row.length === 0) continue;

      var company = row[idxMap['company']] || '';
      var org = row[idxMap['org']] || '';
      var hq = row[idxMap['hqOrOffice']] || '';
      var dept = row[idxMap['department']] || '';
      var employmentType = row[idxMap['employmentType']] || '';
      var jobType = row[idxMap['jobType']] || ''; // ★職種
      var minutes = Number(row[idxMap['minutes']] || 0);
      var guestCount = Number(row[idxMap['guestCount']] || 0);
      var hasExternal = Number(row[idxMap['hasExternalGuest']] || 0) === 1;
      var title = (row[idxMap['eventTitle']] || '').toLowerCase();

      // #exclude が含まれる場合は除外
      if (title.indexOf('#exclude') !== -1) continue;

      var key = [company, org, hq, dept, employmentType, jobType].join('||');
      if (!agg[key]) {
        agg[key] = {
          company: company,
          org: org,
          hq: hq,
          department: dept,
          employmentType: employmentType,
          jobType: jobType,
          externalMeetings: 0,
          externalMinutes: 0,
          onesOnes: 0,
          onesOnesMinutes: 0,
          normal: 0,
          normalMinutes: 0,
          private: 0,
          privateMinutes: 0,
          //others: 0,
          //othersMinutes: 0,
        };
      }

      var entry = agg[key];

      // カテゴリ分類：タイトルタグベース
  //    if (title.indexOf('#1on1') !== -1) {
  //      entry.onesOnes += 1;
  //      entry.onesOnesMinutes += minutes;
  //    } else if (title.indexOf('#external') !== -1) {
  //      entry.externalMeetings += 1;
  //      entry.externalMinutes += minutes;
  //    } else if (title.indexOf('#mtg') !== -1) {
  //      entry.normal += 1;
  //      entry.normalMinutes += minutes;
  //   } else if (title.indexOf('#private') !== -1) {
  //      entry.private += 1;
  //      entry.privateMinutes += minutes;
  //    } else {
  //      // どのタグもない場合はその他
  //      entry.others += 1;
  //      entry.othersMinutes += minutes;
  //    }
   // --- タイトルタグ優先分類（複数タグ時は最初に登場したものを採用） ---
var titleLower = title.toLowerCase();

// 判定対象タグ
var tags = ["#1on1", "#external", "#mtg", "#private"];

// どのタグがtitle内のどこにあるかを取得
var foundTags = [];
tags.forEach(function(tag) {
  var pos = titleLower.indexOf(tag);
  if (pos !== -1) {
    foundTags.push({ tag: tag, pos: pos });
  }
});

var categorized = false;

// --- 1) タイトルタグがある場合 → 最初のタグで分類 ---
if (foundTags.length > 0) {
  foundTags.sort(function(a, b) { return a.pos - b.pos; });
  var firstTag = foundTags[0].tag;

  switch (firstTag) {
    case "#1on1":
      entry.onesOnes++;
      entry.onesOnesMinutes += minutes;
      break;

    case "#external":
      entry.externalMeetings++;
      entry.externalMinutes += minutes;
      break;

    case "#mtg":
      entry.normal++;
      entry.normalMinutes += minutes;
      break;

    case "#private":
      entry.private++;
      entry.privateMinutes += minutes;
      break;
  }

  categorized = true;
}

// --- 2) タグがない場合 → fallback 判定（guestCount, hasExternal） ---
if (!categorized) {

  // ① 社外ゲストがいる場合：人数に関わらず外部会議
  if (hasExternal) {
    entry.externalMeetings++;
    entry.externalMinutes += minutes;

  } else {
    // ② 社内のみ → 人数で1on1 or 通常
    var is1on1 = (guestCount <= 2);

    if (is1on1) {
      entry.onesOnes++;
      entry.onesOnesMinutes += minutes;

    } else {
      entry.normal++;
      entry.normalMinutes += minutes;
    }
  }
}

    }
  });

    // --- 出力 ---
 // var linesOut = [];
 // var headerOutJP = [
 //   (MEMBER_HEADER_JP_MAP['company'] || '会社'),
 //   (MEMBER_HEADER_JP_MAP['org'] || '組織'),
 //   (MEMBER_HEADER_JP_MAP['hqOrOffice'] || '本部・拠点'),
 //  (MEMBER_HEADER_JP_MAP['department'] || '部署'),
 //   (MEMBER_HEADER_JP_MAP['employmentType'] || '雇用形態'),
  //  '職種', // ★追加
 //   'メンバー数',
 //   '社外会議件数',
 //   '社外会議時間(分)',
 //   '1on1件数',
 //   '1on1時間(分)',
 //   '通常会議件数',
 //  '通常会議時間(分)',
 //    '非公開予定',
 //   '非公開予定時間(分)',
 //   'その他件数',
 //   'その他時間(分)'
 // ];
 // linesOut.push(headerOutJP.join(','));

 // Object.keys(agg).sort().forEach(function(k) {
 //   var e = agg[k];
 //   var mkey = [e.company, e.org, e.hq, e.department, e.employmentType, e.jobType].join('||');
  //  var membersCnt = memberCounts[mkey] || 0;
//
 //   var row = [
 //     escapeCsvCell(e.company || ''),
 //     escapeCsvCell(e.org || ''),
 //     escapeCsvCell(e.hq || ''),
 //     escapeCsvCell(e.department || ''),
 //     escapeCsvCell(e.employmentType || ''),
 //     escapeCsvCell(e.jobType || ''), // ★追加
 //     membersCnt,
 //     e.externalMeetings,
 //     e.externalMinutes,
 //     e.onesOnes,
  //    e.onesOnesMinutes,
 //     e.normal,
  //    e.normalMinutes,
  //    e.private,
  //    e.privateMinutes,
  //    e.others,
  //    e.othersMinutes
  //  ];
  //  linesOut.push(row.join(','));
  //});

 // var csv = linesOut.join('\r\n');
 // var outName = 'calendar_summary_' + exportTs + '.csv';
 // var blob = Utilities.newBlob(csv, 'text/csv', outName);
 // var outFile = folder.createFile(blob);
 // Logger.log('Saved calendar summary: ' + outFile.getUrl());
 // return outFile;
 // --- スプレッドシート作成 ---
  var ssName = 'calendar_summary_' + exportTs;
  var ss = SpreadsheetApp.create(ssName);
  var sheet = ss.getActiveSheet();
  sheet.clear();

  var headerOutJP = [
    (MEMBER_HEADER_JP_MAP['company']||'会社'),
    (MEMBER_HEADER_JP_MAP['org']||'組織'),
    (MEMBER_HEADER_JP_MAP['hqOrOffice']||'本部・拠点'),
    (MEMBER_HEADER_JP_MAP['department']||'部署'),
    (MEMBER_HEADER_JP_MAP['employmentType']||'雇用形態'),
    '職種',
    'メンバー数',
    '社外会議件数','社外会議時間(分)',
    '1on1件数','1on1時間(分)',
    '通常会議件数','通常会議時間(分)',
    '非公開予定','非公開予定時間(分)'
    //'その他件数','その他時間(分)'
  ];

  var values = [headerOutJP];

  Object.keys(agg).sort().forEach(function(k){
    var e = agg[k];
    var mkey = [e.company,e.org,e.hq,e.department,e.employmentType,e.jobType].join('||');
    var membersCnt = memberCounts[mkey]||0;
    values.push([
      e.company, e.org, e.hq, e.department, e.employmentType, e.jobType,
      membersCnt,
      e.externalMeetings, e.externalMinutes,
      e.onesOnes, e.onesOnesMinutes,
      e.normal, e.normalMinutes,
      e.private, e.privateMinutes
      //e.others, e.othersMinutes
    ]);
  });

  sheet.getRange(1,1,values.length,values[0].length).setValues(values);

  // 移動: 作成直後はマイドライブなのでフォルダに移動
  var file = DriveApp.getFileById(ss.getId());
  monthFolder.addFile(file);
  DriveApp.getRootFolder().removeFile(file);

  Logger.log('Saved calendar summary spreadsheet: ' + ss.getUrl());
   // ★ここでピボットテーブル作成関数を呼び出す
  createPivotTable(ss);
  return ss;

}

function createPivotTable(ss) {
  const sourceSheet = ss.getActiveSheet();
  let pivotSheet = ss.getSheetByName('Pivot');
  if (!pivotSheet) pivotSheet = ss.insertSheet('Pivot');
  else pivotSheet.clear();

  const lastRow = sourceSheet.getLastRow();
  const lastCol = sourceSheet.getLastColumn();

  // --- 数値列インデックス（1-based） ---
  const numCols = {
    externalMeetings: 8,
    externalMinutes: 9,
    onesOnes: 10,
    onesOnesMinutes: 11,
    normal: 12,
    normalMinutes: 13,
    private: 14,
    privateMinutes: 15
    //others: 16,
    //othersMinutes: 17
  };

  // --- PivotTable作成 ---
  const range = sourceSheet.getRange(1, 1, lastRow, lastCol);
  const pivotTable = pivotSheet.getRange('A1').createPivotTable(range);

  // 行ラベル（小計は本部・拠点のみ表示）
  pivotTable.addRowGroup(1).showTotals(false); // 会社
  pivotTable.addRowGroup(2).showTotals(false); // 組織
  pivotTable.addRowGroup(3).showTotals(false);  // 本部・拠点
  pivotTable.addRowGroup(4).showTotals(true); // 部署
  pivotTable.addRowGroup(5).showTotals(false); // 雇用形態
  pivotTable.addRowGroup(6).showTotals(false); // 職種

  // 値ラベル：元データ列のみ
  const valueCols = Object.values(numCols);
  valueCols.forEach(col => {
    pivotTable.addPivotValue(col, SpreadsheetApp.PivotTableSummarizeFunction.SUM);
  });
}









function testPivotDebug() {
  var ss = SpreadsheetApp.openById('1Tv3HdwtHCHYw_0iMZZEYObxBBn7eJoKxLUbGb_0Evxo');
  createPivotTable(ss);
}


/* ---------- スプレッドシート読み込み ---------- */
function readSpreadsheet(spreadsheetId) {
  var ss = SpreadsheetApp.openById(spreadsheetId);
  var sheet = null;
  // Try to select a sheet that matches FIXED_FROM_DATE pattern like "[YYYY.MM.01]..."
  try {
    if (typeof FIXED_FROM_DATE !== 'undefined' && FIXED_FROM_DATE) {
      var y = FIXED_FROM_DATE.getFullYear();
      var m = ('0' + (FIXED_FROM_DATE.getMonth() + 1)).slice(-2);
      var sheetPattern = new RegExp('^' + y + '\\.' + m + '\\.01.*');
      var sheets = ss.getSheets();
      for (var si = 0; si < sheets.length; si++) {
        var sname = sheets[si].getName();
        if (sheetPattern.test(sname)) {
          sheet = sheets[si];
          Logger.log('readSpreadsheet: selected sheet by FIXED_FROM_DATE pattern: ' + sname);
          break;
        }
      }
    }
  } catch (e) {
    // ignore and fall back
  }
  if (!sheet) sheet = getLatestSheet(ss); // Sheetオブジェクトを返す
  if (sheet && sheet.getName) {
    Logger.log('readSpreadsheet: using sheet: ' + sheet.getName());
  }
  var data = sheet.getDataRange().getValues();
  var members = [];
  for (var i = 1; i < data.length; i++) { // 1行目はヘッダー想定
    var row = data[i];
    // 名前（11列目 index=10）が空ならスキップ
    if (!row[10] || row[10].toString().trim() === '') continue;
    members.push(rowToOrgMember(row));
  }
  return members;
}

function getLatestSheet(spreadsheet) {
  var sheets = spreadsheet.getSheets();
  var latestSheet = sheets[0];
  var latestDate = new Date(0);

  for (var i = 0; i < sheets.length; i++) {
    var s = sheets[i];
    var name = s.getName();
    var match = name.match(/^(\d{4})\.(\d{2})\.(\d{2})/);
    if (match) {
      var date = new Date(match[1], match[2] - 1, match[3]);
      if (date > latestDate) {
        latestDate = date;
        latestSheet = s;
      }
    }
  }
  return latestSheet;
}

function rowToOrgMember(row) {
  return {
    orgId: row[0],
    company: row[1],
    org: row[2],
    hqOrOffice: row[3],
    department: row[4],
    groupOrUnit: row[5],
    team: row[6],
    position: row[7],
    jobTitle: row[8],
    id: row[9],
    name: row[10],
    email: row[11],
    employmentType: row[12],
    mainDuty: row[13],
    mainDutyInGCompany: row[14],
    location: row[15]
  };
}

/* ---------- グループ化・ソート・代表選出 ---------- */
function groupById(members) {
  var grouped = {};
  members.forEach(function(member) {
    var key = (member.id || '').toString();
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(member);
  });
  sortMainDutyFirstPerGroup(grouped)
  return grouped;
}

function sortMainDutyFirstPerGroup(grouped) {
  for (var id in grouped) {
    if (!grouped.hasOwnProperty(id)) continue;
    grouped[id].sort(function(a, b) {
      if ((a.mainDuty || '') === '◯' && (b.mainDuty || '') !== '◯') return -1;
      if ((a.mainDuty || '') !== '◯' && (b.mainDuty || '') === '◯') return 1;
      return 0;
    });
  }
}

function pickRepresentativePerId(grouped, jobTypeMap) {
  var reps = [];
  Object.keys(grouped).sort().forEach(function(id) {
    var arr = grouped[id] || [];
    if (arr.length === 0) return;

    // 代表者選択
    var rep;
    if (arr.length === 1) {
      rep = arr[0];
    } else {
      rep = arr.find(function(m) { return (m.mainDuty || '') === '◯'; }) || arr[0];
    }

    // jobType マージ
    if (rep.email && jobTypeMap) {
      var normEmail = normalizeEmail(rep.email);
      rep.jobType = jobTypeMap[normEmail] || '';
    }

    reps.push(rep);
  });
  return reps;
}

/* ---------- CSV 出力 ---------- */
function exportMembersToDrive(membersOrGrouped, filename) {
  var lines = [];
  var isGrouped = membersOrGrouped && !Array.isArray(membersOrGrouped) && typeof membersOrGrouped === 'object';

  var keys = [];
  if (isGrouped) {
    var firstGroupKey = Object.keys(membersOrGrouped).find(function(k) { return membersOrGrouped[k] && membersOrGrouped[k].length > 0; });
    if (!firstGroupKey) {
      Logger.log('No data to export (grouped empty).');
      return null;
    }
    keys = Object.keys(membersOrGrouped[firstGroupKey][0]);
    // 日本語ヘッダ: グループID + メンバーヘッダ
    var jpHeader = ['グループID'].concat(keys.map(function(k){ return MEMBER_HEADER_JP_MAP[k] || k; }));
    lines.push(jpHeader.join(','));
    var groupKeys = Object.keys(membersOrGrouped).sort();
    groupKeys.forEach(function(gid) {
      var arr = membersOrGrouped[gid] || [];
      arr.forEach(function(m) {
        var row = [escapeCsvCell(gid)];
        keys.forEach(function(k) { row.push(escapeCsvCell(m[k])); });
        lines.push(row.join(','));
      });
    });
  } else {
    var members = membersOrGrouped || [];
    if (members.length === 0) {
      Logger.log('No members to export.');
      return null;
    }
    keys = Object.keys(members[0]);
    // 日本語ヘッダ
    var jpHeader = keys.map(function(k){ return MEMBER_HEADER_JP_MAP[k] || k; });
    lines.push(jpHeader.join(','));
    members.forEach(function(m) {
      var row = keys.map(function(k) { return escapeCsvCell(m[k]); });
      lines.push(row.join(','));
    });
  }

  var csv = lines.join('\r\n');
  var outName = filename || 'members.csv';
  var blob = Utilities.newBlob(csv, 'text/csv', outName);


  // ROOT_FOLDER_NAME を取得
  let rootFolders = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
  let rootFolder = rootFolders.hasNext() ? rootFolders.next() : DriveApp.createFolder(ROOT_FOLDER_NAME);

  // FOLDER_NAME を ROOT_FOLDER_NAME の下に取得
  let monthFolders = rootFolder.getFoldersByName(FOLDER_NAME);
  let monthFolder = monthFolders.hasNext() ? monthFolders.next() : rootFolder.createFolder(FOLDER_NAME);

  // EVENT_FOLDER_NAME を FOLDER_NAME の下に取得
  let eventFolders = monthFolder.getFoldersByName(EVENT_FOLDER_NAME);
  let eventFolder = eventFolders.hasNext() ? eventFolders.next() : monthFolder.createFolder(EVENT_FOLDER_NAME);

  var file = eventFolder.createFile(blob);
  Logger.log('Saved CSV: ' + file.getUrl());
  return file;
}

/**
 * Drive に保存した members CSV を読み込み、members 配列に復元する
 * CSV は exportMembersToDrive の出力形式を仮定する
 */
function readMembersFromDrive(fileId) {
  try {
    var file = DriveApp.getFileById(fileId);
    var content = file.getBlob().getDataAsString();
    // 改行は CRLF または LF をサポート
    var lines = content.split(/\r?\n/).filter(function(l){ return l !== ''; });
    if (lines.length < 2) return [];
    var header = lines[0].split(',').map(function(h){ return h.replace(/^"|"$/g, '').trim(); });
    var members = [];
    for (var i = 1; i < lines.length; i++) {
      var row = parseCsvLine(lines[i]);
      if (!row || row.length === 0) continue;
      var obj = {};
      // header may be Japanese labels; map them back when possible
      for (var j = 0; j < header.length; j++) {
        var h = header[j] || ('col' + j);
        var key = JP_MEMBER_HEADER_TO_KEY[h] || h;
        obj[key] = (row[j] !== undefined) ? row[j] : '';
      }
      // 最低限のフィールド名を揃える（元の rowToOrgMember が使うキーに合わせる）
      // 元ファイルが grouped 形式のときは最初の列が groupId になるため対応
      if (obj['groupId']) {
        // grouped 出力: groupId, then keys...
        // keys likely include orgId,company,org,... so copy as-is
      }
      members.push(obj);
    }
    // 注意: 文字列のまま戻すため、後続処理が期待するキー名・型に合わない場合がある
    return members;
  } catch (e) {
    throw new Error('readMembersFromDrive failed: ' + e.toString());
  }
}

// 単純 CSV パーサ: カンマ区切り、ダブルクォート対応
function parseCsvLine(line) {
  var res = [];
  var cur = '';
  var inQuotes = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i+1] === '"') {
          cur += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        res.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
  }
  res.push(cur);
  return res;
}

function escapeCsvCell(value) {
  if (value === null || value === undefined) return '';
  var s = value.toString();
  if (s.indexOf('"') !== -1) s = s.replace(/"/g, '""');
  if (s.indexOf(',') !== -1 || s.indexOf('\n') !== -1 || s.indexOf('"') !== -1) {
    s = '"' + s + '"';
  }
  return s;
}


function getEventDetailsForEmail(email, fromDate, toDate, emailToIdMap, expandedGroupCache) {
  const result = { email: email, events: [], totalMinutes: 0 };
  if (!email) return result;

  let cal;
  try {
    cal = CalendarApp.getCalendarById(email);
    if (!cal) {
      addMyCalenderToMyList(email);
      cal = CalendarApp.getCalendarById(email);
    }
  } catch (e) {
    Logger.log('Calendar access error for %s: %s', email, e.toString());
    return result;
  }

  let events = [];
  try {
    events = cal.getEvents(fromDate, toDate);
  } catch (e) {
    Logger.log('Error getting events for %s: %s', email, e.toString());
    return result;
  }

  //const emailNorm = email.toLowerCase();
  //const tz = Session.getScriptTimeZone();

  // email→IDマッピングキャッシュ（lowerCase化）
  const normalizedIdMap = {};
  Object.keys(emailToIdMap || {}).forEach(k => {
    normalizedIdMap[k.toLowerCase()] = emailToIdMap[k];
  });

  for (let ev of events) {
    try {
      if (typeof ev.isAllDayEvent === 'function' && ev.isAllDayEvent()) continue;

      let title = ev.getTitle() || '';
      let visibility = '';
      try { visibility = ev.getVisibility ? ev.getVisibility().toLowerCase() : ''; } catch(e){}

      // 非公開予定
      if (!title || title === '予定' || title === '予定あり' || visibility.includes('private')) {
        const start = ev.getStartTime();
        const end = ev.getEndTime();
        const minutes = Math.max(0, (end - start) / (1000 * 60));
        result.events.push({
          title: '#private',
          start: start,
          end: end,
          minutes: Math.round(minutes),
          guestCount: 0,
          guests: [],
          organizer: '',
          hasExternalGuest: false,
          attendeeStatusJson:''
        });
        result.totalMinutes += minutes;
        continue;
      }

      // 通常予定処理
      //const guests = (ev.getGuestList && ev.getGuestList()) || [];
      //const guestEmails = guests.map(g => g.getEmail().toLowerCase()).filter(Boolean);
      const guests = (ev.getGuestList && ev.getGuestList()) || [];

      // 参加者ステータス（JSON用）
      const attendeeStatuses = [];

      // email -> status（グループ展開前）
      guests.forEach(g => {
        const email = (g.getEmail && g.getEmail()) ? g.getEmail().toLowerCase() : '';
        if (!email) return;

        attendeeStatuses.push({
          email: email,
          status: mapGuestStatus(g)
       });
      });



      // --- グループ展開・重複削除（キャッシュ利用） ---
      const expandedGuests = [];
      const seen = {};

      attendeeStatuses.forEach(a => {
        const email = a.email;
        const members = expandedGroupCache[email] || [email];

        members.forEach(m => {
          if (!m) return;
          if (!seen[m]) {
            seen[m] = true;
            expandedGuests.push(m);
          }
        });
      });


      // リソース除外
      const filteredGuestEmails = expandedGuests.filter(g => g && !isResourceEmail(g));

      const creators = (ev.getCreators && ev.getCreators()) || [];
      const organizer = creators.length ? creators[0] : null;
      const organizerNorm = organizer ? organizer.toLowerCase() : null;

      const combinedEmails = [organizerNorm, ...filteredGuestEmails].filter(Boolean);
      const idSet = {};
      combinedEmails.forEach(e => {
        const mapped = normalizedIdMap[e];
        if (mapped) idSet[mapped] = true;
      });

      if (Object.keys(idSet).length <= 1) continue;

      const start = ev.getStartTime();
      const end = ev.getEndTime();
      const minutes = Math.max(0, (end - start) / (1000 * 60));

      const hasExternalGuest = filteredGuestEmails.some(g => {
        const parts = g.split('@');
        if (parts.length < 2) return true;
        const domain = parts.slice(1).join('@');
        return INTERNAL_DOMAINS.indexOf(domain) === -1;
      });

      result.events.push({
        title: title,
        start: start,
        end: end,
        minutes: Math.round(minutes),
        guestCount: Object.keys(idSet).length,
        guests: filteredGuestEmails,
        organizer: organizer,
        hasExternalGuest: hasExternalGuest,
        attendeeStatusJson: JSON.stringify(attendeeStatuses)
      });

      result.totalMinutes += minutes;
    } catch (e) {
      Logger.log('Error processing event for %s: %s', email, e.toString());
    }
  }

  try { removeCalendarFromMyList(email); } catch(e){}

  result.totalMinutes = Math.round(result.totalMinutes);
  return result;
}

// ヘルパー: IDマッピング高速版
function mapGuestToIdFast(email, emailToIdMap) {
  if (!email) return null;
  if (emailToIdMap && emailToIdMap[email]) return emailToIdMap[email];

  const parts = email.split('@');
  if (parts.length !== 2) return email;

  const local = parts[0];
  const domain = parts[1];

  for (let k in emailToIdMap) {
    if (!emailToIdMap.hasOwnProperty(k)) continue;
    const kp = k.split('@')[0];
    const kd = k.split('@')[1] || '';
    if (kp === local && INTERNAL_DOMAINS.includes(kd)) return emailToIdMap[k];
  }

  return email;
}

//ゲストステータス変換ヘルパー
function mapGuestStatus(guest) {
  // CalendarApp.GuestStatus
  switch (guest.getGuestStatus()) {
    case CalendarApp.GuestStatus.YES:
      return '承認';
    case CalendarApp.GuestStatus.NO:
      return '辞退';
    case CalendarApp.GuestStatus.MAYBE:
      return '未定';
    case CalendarApp.GuestStatus.INVITED:
    default:
      return '未回答';
  }
}



function buildEmailToIdMap(members) {
  // 同じメールアドレスが複数行ある場合に備えてグループ化して代表IDを選ぶ
  // 優先ルール: mainDuty が '◯' の行を優先、それが無ければ最初の行の id を採用
  var map = {};
  if (!members || !Array.isArray(members)) return map;

  var groups = {};
  members.forEach(function(m) {
    var e = normalizeEmail(m.email);
    if (!e) return;
    if (!groups[e]) groups[e] = [];
    groups[e].push(m);
  });

  Object.keys(groups).forEach(function(email) {
    var arr = groups[email];
    if (!arr || arr.length === 0) {
      map[email] = email;
      return;
    }
    // mainDuty を優先
    var found = arr.find(function(x){ return (x.mainDuty || '') === '◯'; });
    var chosen = found || arr[0];
    map[email] = (chosen.id && chosen.id.toString()) || email;
  });

  return map;
}

function normalizeEmail(email) {
  return (email || '').toString().trim().toLowerCase();
}

/**
 * 代表者一覧から各イベントを集め、CSVとして Drive に保存する
 * CSVカラム: repId,repName,repEmail,eventTitle,start,end,minutes,participantsCount,organizer
 */
function bk_exportCalendarEventsToDrive(representatives, fromDate, toDate, emailIdMap, filename,detailsCache,groupMembersMap) {
  if (!Array.isArray(representatives) || representatives.length === 0) {
    Logger.log('No representatives to export events.');
    return null;
  }

  var lines = [];
  // repId, repName, repEmail, hqOrOffice(本部), department(部), employmentType, eventTitle, start, end, minutes, guestCount, organizer, hasExternalGuest, guestList
  var header = ['repId','repName','repEmail','company','org','hqOrOffice','department','employmentType','jobType','eventTitle','start','end','minutes','guestCount','organizer', 'hasExternalGuest','guestList'];
  // 日本語ヘッダを出力
  var jpHeader = header.map(function(k){ return EVENT_HEADER_JP_MAP[k] || k; });
  lines.push(jpHeader.join(','));

  var tz = Session.getScriptTimeZone();

  representatives.forEach(function(rep) {
    if (!rep || !rep.email) return;
    var key = normalizeEmail(rep.email);
    var details = (detailsCache && detailsCache[key]) || null;
    if (!details) {
      details = getEventDetailsForEmail(rep.email, fromDate, toDate, emailIdMap,groupMembersMap);
    }
    if (!details || !details.events || details.events.length === 0) return;
    details.events.forEach(function(ev) {
      var startStr = ev.start ? Utilities.formatDate(new Date(ev.start), tz, "yyyy-MM-dd'T'HH:mm:ss") : '';
      var endStr = ev.end ? Utilities.formatDate(new Date(ev.end), tz, "yyyy-MM-dd'T'HH:mm:ss") : '';
      var guestsStr = (ev.guests && ev.guests.length) ? ev.guests.join(';') : '';
      var row = [
        escapeCsvCell(rep.id || ''),
        escapeCsvCell(rep.name || ''),
        escapeCsvCell(rep.email || ''),
        escapeCsvCell(rep.company || ''),
        escapeCsvCell(rep.org || ''),
        escapeCsvCell(rep.hqOrOffice || ''),
        escapeCsvCell(rep.department || ''),
        escapeCsvCell(rep.employmentType || ''),
        escapeCsvCell(rep.jobType || ''),
        escapeCsvCell(ev.title || ''),
        escapeCsvCell(startStr),
        escapeCsvCell(endStr),
        escapeCsvCell(ev.minutes || 0),
        escapeCsvCell(ev.guestCount || 0),
        escapeCsvCell(ev.organizer || ''),
        escapeCsvCell(ev.hasExternalGuest ? '1' : '0'),
        escapeCsvCell(guestsStr),
      ];
      lines.push(row.join(','));
    });
  });

  if (lines.length === 1) {
    Logger.log('No event rows collected.');
    return null;
  }

  var csv = lines.join('\r\n');
  var outName = filename || 'calendar_events.csv';
  var blob = Utilities.newBlob(csv, 'text/csv', outName);

 var rootFolders = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
  var mainFolder = rootFolders.hasNext() ? rootFolders.next() : DriveApp.createFolder(ROOT_FOLDER_NAME);

  var monthFolders = mainFolder.getFoldersByName(FOLDER_NAME);
  var folder = monthFolders.hasNext() ? monthFolders.next() : mainFolder.createFolder(monthFolderName);

  var file = folder.createFile(blob);
  Logger.log('Saved calendar CSV: ' + file.getUrl());
  return file;
}
function exportCalendarEventsToDrive(representatives, fromDate, toDate, emailIdMap, filename, detailsCache, groupMembersMap) {
  //updateHeartbeat();
  if (!Array.isArray(representatives) || representatives.length === 0) return null;

  const lines = [];
  const header = ['repId','repName','repEmail','company','org','hqOrOffice','department','employmentType','jobType','eventTitle','start','end','minutes','guestCount','organizer', 'hasExternalGuest','guestList','gueststatus'];
  const jpHeader = header.map(k => EVENT_HEADER_JP_MAP[k] || k);
  lines.push(jpHeader.join(','));

  const tz = Session.getScriptTimeZone();
 // 🔸 グループ展開キャッシュを一度だけ構築
  const expandedGroupCache = buildExpandedGroupCache(groupMembersMap);
  for (let rep of representatives) {
    if (!rep || !rep.email) continue;
    const key = rep.email.toLowerCase();
    let details = (detailsCache && detailsCache[key]) || null;
    if (!details) {
      details = getEventDetailsForEmail(rep.email, fromDate, toDate, emailIdMap, expandedGroupCache);
      if (detailsCache) detailsCache[key] = details;
    }
    if (!details || !details.events.length) continue;

    for (let ev of details.events) {
      const startStr = ev.start ? Utilities.formatDate(new Date(ev.start), tz, "yyyy-MM-dd'T'HH:mm:ss") : '';
      const endStr = ev.end ? Utilities.formatDate(new Date(ev.end), tz, "yyyy-MM-dd'T'HH:mm:ss") : '';
      const guestsStr = ev.guests && ev.guests.length ? ev.guests.join(';') : '';

      const row = [
        escapeCsvCell(rep.id || ''),
        escapeCsvCell(rep.name || ''),
        escapeCsvCell(rep.email || ''),
        escapeCsvCell(rep.company || ''),
        escapeCsvCell(rep.org || ''),
        escapeCsvCell(rep.hqOrOffice || ''),
        escapeCsvCell(rep.department || ''),
        escapeCsvCell(rep.employmentType || ''),
        escapeCsvCell(rep.jobType || ''),
        escapeCsvCell(ev.title || ''),
        escapeCsvCell(startStr),
        escapeCsvCell(endStr),
        escapeCsvCell(ev.minutes || 0),
        escapeCsvCell(ev.guestCount || 0),
        escapeCsvCell(ev.organizer || ''),
        escapeCsvCell(ev.hasExternalGuest ? '1' : '0'),
        escapeCsvCell(guestsStr),
        escapeCsvCell(ev.attendeeStatusJson || '')
      ];

      lines.push(row.join(','));
    }
  }

  if (lines.length === 1) return null;

  const csv = lines.join('\r\n');
  const outName = filename || 'calendar_events.csv';
  const blob = Utilities.newBlob(csv, 'text/csv', outName);

  // --- フォルダ決定ロジック（ROOT_FOLDER_NAME / FOLDER_NAME / EVENT_FOLDER_NAME は外側でセット済み） ---
  var rootFolders = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
  var mainFolder = rootFolders.hasNext() ? rootFolders.next() : DriveApp.createFolder(ROOT_FOLDER_NAME);

  // 月フォルダ（FOLDER_NAME）を mainFolder の下に作る（または取得）
  var monthFolders = mainFolder.getFoldersByName(FOLDER_NAME);
  var monthFolder = monthFolders.hasNext() ? monthFolders.next() : mainFolder.createFolder(FOLDER_NAME);

  // その月フォルダの下にイベント格納用フォルダ（EVENT_FOLDER_NAME）を作成（または取得）
  var eventFolders = monthFolder.getFoldersByName(EVENT_FOLDER_NAME);
  var eventFolder = eventFolders.hasNext() ? eventFolders.next() : monthFolder.createFolder(EVENT_FOLDER_NAME);

// 最終的な保存先は eventFolder
　 return eventFolder.createFile(blob);

}

function buildExpandedGroupCache(groupMembersMap) {
  const cache = {};
  Object.keys(groupMembersMap || {}).forEach(g => {
    cache[g.toLowerCase()] = (Array.isArray(groupMembersMap[g]) ? groupMembersMap[g] : [g])
      .map(m => m?.toLowerCase())
      .filter(Boolean);
  });
  return cache;
}



function testFunction(){
  var email = "nakade.takuya@moneyforward.co.jp"

  // 日付範囲（過去1ヶ月）
  var toDate = new Date();
  var fromDate = new Date();
  fromDate.setMonth(toDate.getMonth() - 1);

  // 7) 各代表のカレンダーを走査してイベント詳細を取得
  var cal;
  try {
    cal = CalendarApp.getCalendarById(email);
    if (!cal){
  if (addMyCalenderToMyList(email)){
        cal = CalendarApp.getCalendarById(email);
      }
    }
    Logger.log('取得件数:' + cal.getEvents(fromDate, toDate).length)
  } catch (e) {
    Logger.log('Calendar access error for %s: %s', email, e.toString());
  }
}

function addMyCalenderToMyList(calendarId){
    if (typeof Calendar === 'undefined' || !Calendar.CalendarList || !Calendar.CalendarList.insert) {
      Logger.log('Advanced Calendar service is not enabled; cannot add calendar to list: ' + calendarId);
      return false;
    }
    try {
      // Resource は id フィールドのみで OK
      var resource = { id: calendarId };
      var added = Calendar.CalendarList.insert(resource);
      return true;
    } catch (e) {
      Logger.log('Failed to add calendar: ' + calendarId + ' cause:' + e.toString());
      // 典型エラー: 403 (Not shared) / 404 (not found)
      return false;
    }
}
function removeCalendarFromMyList(calendarId) {
  if (typeof Calendar === 'undefined' || !Calendar.CalendarList || !Calendar.CalendarList.remove) {
    Logger.log('Advanced Calendar service is not enabled; cannot remove calendar from list: ' + calendarId);
    return false;
  }
  try {
    Calendar.CalendarList.remove(calendarId);
    return true;
  } catch (e) {
    Logger.log('Failed to remove: ' + e.toString());
    return false;
  }
}

/**
 * resource（会議室・リソース）メールアドレスかどうかを判定する
 * - 代表的な形式: resource.calendar.google.com のようなドメイン、
 *   またはアドレス内に "resource" や "room" を含む場合を簡易判定
 */
function isResourceEmail(email) {
  if (!email) return false;
  var e = (email || '').toString().toLowerCase();
  // 明示的に除外リストに入れているドメインを先にチェック
  for (var i = 0; i < RESOURCE_DOMAINS.length; i++) {
    if (e.indexOf('@' + RESOURCE_DOMAINS[i]) !== -1) return true;
  }
  // 簡易ルール: ローカル部分やドメインに room や resource を含む場合はリソース扱い
  if (e.indexOf('room') !== -1 || e.indexOf('resource') !== -1) return true;
  return false;
}

function getMembers(membersFileId){
    var members = null;
    if (membersFileId) {
    // 既存メンバファイルがある場合は Drive から読み込んで再利用
    try {
      members = readMembersFromDrive(membersFileId);
      if (!members || members.length === 0) {
        // 何らかの理由でファイルが壊れている/空の場合はスプレッドシートから再生成
        members = readSpreadsheet(SPREAD_SHEET_ID);
      }
    } catch (e) {
      Logger.log('Failed to read members from Drive fileId=' + membersFileId + ' - falling back to spreadsheet: ' + e.toString());
      members = readSpreadsheet(SPREAD_SHEET_ID);
    }
  } else {
    // 初回: スプレッドシートから読み込み
    members = readSpreadsheet(SPREAD_SHEET_ID);
  }
  return members;
}

function addJobTypeToLatestMemberCsv() {
  const props = PropertiesService.getScriptProperties();
  const fileId = props.getProperty('ocr_members_fileId');
  if (!fileId) {
    Logger.log('❌ ocr_members_fileId が設定されていません。');
    return;
  }

  // === 1. 社員一覧シートの読み込み ===
  const jobSheetName = '社員一覧'; // 職種情報を持つシート名
  const ss = SpreadsheetApp.openById(SPREAD_JOB_ID);
  const jobSheet = ss.getSheetByName(jobSheetName);
  const jobValues = jobSheet.getDataRange().getValues();
  const jobHeader = jobValues[0];

  const employeeNoIdx = jobHeader.indexOf('社員番号');
  const jobIdx = jobHeader.indexOf('職種');
  if (employeeNoIdx === -1 || jobIdx === -1) {
    throw new Error('社員一覧シートに「社員番号」または「職種」列が見つかりません。');
  }

  // 🔧 社員番号 → 職種 のマップ作成
  const jobMap = {};
  for (let i = 1; i < jobValues.length; i++) {
    const row = jobValues[i];
    const no = String(row[employeeNoIdx]).trim();
    const job = String(row[jobIdx]).trim();
    if (no && job) jobMap[no] = job;
  }
  Logger.log(`職種マッピング件数: ${Object.keys(jobMap).length}`);

  // === 2. member_*.csv の読み込み ===
  const file = DriveApp.getFileById(fileId);
  const csvText = file.getBlob().getDataAsString('UTF-8');
  const lines = csvText.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length < 2) {
    Logger.log('CSVの内容が空です。');
    return;
  }

  const headers = lines[0].split(',');
  const idIdx = headers.indexOf('社員ID');
  if (idIdx === -1) {
    throw new Error('member_*.csv に「社員ID」列が見つかりません。');
  }

  // 職種列が存在しない場合は追加
  let jobCol = headers.indexOf('職種');
  if (jobCol === -1) {
    headers.push('職種');
    jobCol = headers.length - 1;
  }

  const updatedLines = [headers.join(',')];
  let unmatchedCount = 0;

  // === 3. 行ごとに突合して職種を追加 ===
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < headers.length - 1) continue; // 空行スキップ
    const empId = String(cols[idIdx]).trim();
    const job = jobMap[empId] || '';
    if (!job) unmatchedCount++;
    cols[jobCol] = job;
    updatedLines.push(cols.join(','));
  }

  const updatedCsv = updatedLines.join('\r\n');

  // === 4. 上書き保存 ===
  const blob = Utilities.newBlob(updatedCsv, 'text/csv', file.getName());
  const folder = file.getParents().hasNext() ? file.getParents().next() : DriveApp.getRootFolder();
  const newFile = folder.createFile(blob);
  file.setTrashed(true); // 旧ファイルをゴミ箱へ移動
  props.setProperty('ocr_members_fileId', newFile.getId());

  Logger.log(`職種を追加したCSVを保存しました: ${newFile.getUrl()}`);
  Logger.log(`職種が見つからなかった件数: ${unmatchedCount}`);
}


function saveMembersCsv(props, grouped){
    // 初回実行時のみメンバCSVを作成し、ファイルIDを ScriptProperties に保存する
  var tsNow = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss'); // カレンダー出力に使うタイムスタンプ。既存メンバファイルがあればそれに合わせる
  var exportTs = tsNow;
  if (!props.getProperty('ocr_members_fileId')) {
    var membersFile = exportMembersToDrive(grouped, 'member_' + tsNow + '.csv');
    try {
      if (membersFile && membersFile.getId) {
          props.setProperty('ocr_members_fileId', membersFile.getId());
        Logger.log('Saved members CSV fileId=' + membersFile.getId());
        // 作成したファイル名に使った ts を exportTs として使う
        exportTs = tsNow;
      }
    } catch (e) {
      Logger.log('Failed to persist members fileId to properties: ' + e.toString());
    }
  } else {
    Logger.log('Using existing members CSV fileId=' + props.getProperty('ocr_members_fileId'));
    // 既存のメンバファイル名からタイムスタンプを抽出する
    try {
      var existingId = props.getProperty('ocr_members_fileId');
      var existingFile = DriveApp.getFileById(existingId);
      var name = existingFile.getName() || '';
      // ファイル名に member_YYYYMMDD_HHMMSS が使われている想定
      var m = name.match(/member_(\d{8}_\d{6})/);
      if (m && m[1]) {
        exportTs = m[1];
      } else {
        // 代替: 最終更新日時を使う
        try {
          var lu = existingFile.getLastUpdated();
          exportTs = Utilities.formatDate(new Date(lu), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss');
        } catch (e2) {
          exportTs = tsNow;
        }
      }
    } catch (e) {
      Logger.log('Failed to read existing members file for ts: ' + e.toString());
      exportTs = tsNow;
    }
  }
  return exportTs;
}

function getEvent(start, end, representatives, uniqueEmails, fromDate, toDate, emailIdMap,groupMembersMap){
  var emailReps = [];
  var detailsCache = {}; // 同一実行内キャッシュ: normalizedEmail -> details
  //var groupMembersMap = loadGroupMembersMapFromSheet();
  // 🔸 グループ展開キャッシュを一度だけ構築
  const expandedGroupCache = buildExpandedGroupCache(groupMembersMap);
  for (var localIdx = start; localIdx < end; localIdx++) {
    var email = uniqueEmails[localIdx];
    // LOG_EVERY ごとに進捗ログ
    var processedCount = localIdx - start + 1;
    if (processedCount > 0 && processedCount % LOG_EVERY === 0) {
      Logger.log('Processed ' + processedCount + ' unique emails in this chunk (global index ' + localIdx + ' of ' + uniqueEmails.length + ') - current: ' + (email || 'n/a'));
    }
    if (!email) continue;

    // 代表メタ情報を見つける（なければ簡易オブジェクトを作成）
    var repMeta = (representatives || []).find(function(r) { return normalizeEmail(r.email) === normalizeEmail(email); });
    if (!repMeta) {
      // フォールバック: email が representatives に見つからない場合、email -> id マップから id を取り出し、id で代表を探す
      try {
        var normEmail = normalizeEmail(email);
        var repIdFromMap = (emailIdMap && emailIdMap[normEmail]) || null;
        if (repIdFromMap) {
          repMeta = (representatives || []).find(function(r) { return (r.id && r.id.toString()) === repIdFromMap.toString(); });
        }
      } catch (e) {
        // ignore
      }
      if (!repMeta) {
        // デバッグ情報を少し詳しく残す（代表リストの先頭数件をログに出す）
        var sampleReps = (representatives || []).slice(0,5).map(function(r){ return normalizeEmail((r && r.email) || ''); });
        Logger.log('repMeta is not found index:' + localIdx + ' unique emails:' + email + ' sampleReps:' + JSON.stringify(sampleReps));
        repMeta = { id: (emailIdMap && emailIdMap[normalizeEmail(email)]) || '', name: '', email: email, hqOrOffice: '', department: '' };
      }
    }
  emailReps.push(repMeta);

    var key = normalizeEmail(email);
    var details = detailsCache[key];
    if (!details) {
      details = getEventDetailsForEmail(email, fromDate, toDate, emailIdMap,expandedGroupCache);
      detailsCache[key] = details || { email: email, events: [], totalMinutes: 0 };
    }
    if (!details || details.events.length === 0) continue;

    // details.events.forEach(function(ev) {
    //   Logger.log('title:' + ev.title + '、start:' + ev.start + '、end:' + ev.end + '、minutes:' + ev.minutes + '、guestCount:' + ev.guestCount + '、organizer:' + ev.organizer);
    // });
  }
  return { detailsCache: detailsCache, emailReps: emailReps };
}



function endLogic(end, props, uniqueEmails, partIndex, exportTs){
  props.setProperty('ocr_last_heartbeat', String(Date.now()));
  if (end < uniqueEmails.length) {
    props.setProperty('ocr_part_index', String(partIndex + 1));
    Logger.log('Chunk processed. Saved cursor=' + end + '. Scheduling next run.');
    // 既存の myFunction トリガーがあっても上書きして、必ず1分後のワンショットトリガーを作成する
    try {
      var projTriggers = ScriptApp.getProjectTriggers() || [];
      var matches = projTriggers.filter(function(t){ return t.getHandlerFunction && t.getHandlerFunction() === 'myFunction'; });
      if (matches.length > 0) {
        Logger.log('Found ' + matches.length + ' existing myFunction trigger(s); deleting them to recreate.');
        matches.forEach(function(t) {
          try {
            ScriptApp.deleteTrigger(t);
            Logger.log('Deleted trigger id=' + (t.getUniqueId ? t.getUniqueId() : 'n/a'));
          } catch (delErr) {
            Logger.log('Failed to delete trigger: ' + delErr.toString());
          }
        });
      }
      // 新しいワンショットトリガーを作成
      try {
        ScriptApp.newTrigger('myFunction').timeBased().after(20 * 1000).create();
        Logger.log('Created one-off trigger to resume processing in 20 seconds.');
      } catch (createErr) {
        Logger.log('Failed to create one-off trigger: ' + createErr.toString());
      }
    } catch (e) {
      Logger.log('Trigger recreate logic failed: ' + e.toString());
    }
  } else {
    // 完了: プロパティを削除
    // exportTs を保存しておき、別トリガで集計を実行する
    try {
      props.setProperty('ocr_last_export_ts', exportTs);
    } catch (e) {
      Logger.log('Failed to persist exportTs to properties: ' + e.toString());
    }
    Logger.log('All chunks processed. Completed export.');
    Logger.log('Scheduling aggregation trigger in 20 seconds.');
    // スケジュール済みの古い集計トリガを削除してから作成
    cancelScheduledAggregation();
    try {
      ScriptApp.newTrigger('runScheduledAggregation').timeBased().after(20 * 1000).create();
      Logger.log('Created scheduled trigger to run aggregation in 20 seconds.');
    } catch (e2) {
      Logger.log('Failed to create aggregation trigger: ' + e2.toString());
    }
    // 最後にプロパティは削除（ただし ocr_last_export_ts は残す）
    try {
      var last = props.getProperty('ocr_last_export_ts');
      // remove other temporary props but keep last export ts
      props.deleteAllProperties();
      if (last) props.setProperty('ocr_last_export_ts', last);
    } catch (e3) {
      Logger.log('Failed to cleanup properties: ' + e3.toString());
    }
  }
}

/**
 * スケジュールトリガから呼ばれる: Properties に保存された exportTs を取り出して実行する
 */
function runScheduledAggregation() {
  var props = PropertiesService.getScriptProperties();
  Logger.log('Script properties: ' + JSON.stringify(props.getProperties()));
  var exportTs = props.getProperty('ocr_last_export_ts');
  if (!exportTs) {
    Logger.log('No exportTs found in properties; nothing to aggregate.');
    return null;
  }
  Logger.log('Running scheduled aggregation for exportTs=' + exportTs);
  try {
    //var res = aggregateCalendarEventPartsToSummary(exportTs);
    runDivisionExportTrigger();
    // 成功したらプロパティの exportTs を削除
    //props.deleteProperty('ocr_last_export_ts');
    // そして自分のトリガは削除
    //cancelScheduledAggregation();
    //return res;
    return true;
  } catch (e) {
    Logger.log('Scheduled aggregation failed: ' + e.toString());
    throw e;
  }
}

/**
 * スケジュール済みの runScheduledAggregation トリガを削除するユーティリティ
 */
function cancelScheduledAggregation() {
  try {
    var triggers = ScriptApp.getProjectTriggers() || [];
    triggers.forEach(function(t){
      try {
        if (t.getHandlerFunction && t.getHandlerFunction() === 'runScheduledAggregation') {
          ScriptApp.deleteTrigger(t);
          Logger.log('Deleted existing scheduled aggregation trigger.');
        }
      } catch (e) {
        // ignore single trigger delete failures
      }
    });
  } catch (e) {
    Logger.log('Failed to cancel scheduled aggregation triggers: ' + e.toString());
  }
}

/**
 * 手動トリガで最新の exportTs を見つけて集計を実行するユーティリティ
 * - デフォルトの出力フォルダ（`FOLDER_NAME`）から最新の member_ or calendar_events_ のタイムスタンプを探して aggregate を呼ぶ
 */
function runAggregationForLatestExport() {
  var folders = DriveApp.getFoldersByName(FOLDER_NAME);
  if (!folders.hasNext()) {
    Logger.log('No export folder found: ' + FOLDER_NAME);
    return null;
  }
  var folder = folders.next();
  var files = folder.getFiles();
  var latestTs = null;
  while (files.hasNext()) {
    var f = files.next();
    var name = f.getName();
    var m = name.match(/_(\d{8}_\d{6})/);
    if (m && m[1]) {
      if (!latestTs || m[1] > latestTs) latestTs = m[1];
    }
  }
  if (!latestTs) {
    Logger.log('No timestamped export files found in ' + FOLDER_NAME);
    return null;
  }
  Logger.log('Found latest exportTs: ' + latestTs + '. Running aggregation.');
  return aggregateCalendarEventPartsToSummary(latestTs);
}

/**
 * 明示的なタイムスタンプを与えて集計を実行するユーティリティ
 */
function runAggregation(exportTs) {
  if (!exportTs) {
    Logger.log('exportTs is required. Example: "20250926_130806"');
    return null;
  }
  return aggregateCalendarEventPartsToSummary(exportTs);
}

// groupKey: group email or group id
function listGroupMembers(groupKey) {
  var members = [];
  var pageToken;
  do {
    var resp = AdminDirectory.Members.list(groupKey, {
      pageToken: pageToken,
      maxResults: 200
    });
    if (resp.members && resp.members.length) {
      // resp.members の要素例: {email:'u@example.com', role:'MEMBER', id:'...'}
      // members = members.concat(resp.members.map(function(m){ return {email: m.email, id: m.id, role: m.role}; }));
      for (var i = 0; i < resp.members.length; i++) {
        var m = resp.members[i];
        if (m && m.email) {
          members.push(m.email.toLowerCase());
        }
      }
    }
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return members;
}

function listGroupMembers2(groupKey) {
  var members = [];
  var group = GroupsApp.getGroupByEmail(groupKey);
  var users = group.getUsers();

  if (users.length) {
    for (var i = 0; i < users.length; i++) {
      var m = users[i];
      if (m && m.getEmail()) {
        members.push(m.getEmail().toLowerCase());
      }
    }
  }
  return members;
}

function getMyGroupList(){
  var members = [];
  const groups = GroupsApp.getGroups();
  if (groups.length) {
    for (var i = 0; i < groups.length; i++) {
      var m = groups[i];
      if (m && m.getEmail()) {
        members.push(m.getEmail().toLowerCase());
      }
    }
  }
  Logger.log(`You belong to ${groups.length} groups.  ${members.join(':')}`);
}

function groupTest(){
  getMyGroupList();

  var members = listGroupMembers2('cto-office@moneyforward.co.jp');
  Logger.log('members : %s', members.join(":"));
}



function loadGroupMembersMapFromSheet() {
try { 
  const ss = SpreadsheetApp.openById(GROUP_SHEET_ID);
  const sheet = ss.getSheets()[0]; //
  //const sheet = ss.getSheetByName(GROUP_SHEET_NAME);
  if (!sheet) {
   // Logger.log(シート "${SHEET_NAME}" が見つかりません);
    return {};
  }

  const values = sheet.getDataRange().getValues();
  if (!values || values.length < 2) {
    //Logger.log('スプレッドシートにデータがありません');
    return {};
  }

  // 1行目（ヘッダー）を取得
  const header = values[0];
  const groupCol = header.indexOf('グループアドレス');
  const membersCol = header.indexOf('メンバー一覧（セミコロン区切り）');

  if (groupCol === -1 || membersCol === -1) {
    //Logger.log(ヘッダーが見つかりません: ${header.join(',')});
    return {};
  }

  const map = {};
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const groupAddr = (row[groupCol] || '').toString().trim().toLowerCase();
    const membersStr = (row[membersCol] || '').toString().trim();
    if (!groupAddr) continue;

    const members = membersStr
      ? membersStr.split(';').map(s => s.trim().toLowerCase()).filter(Boolean)
      : [];
    map[groupAddr] = members;
  }
    //Logger.log(グループマップ読み込み完了（${Object.keys(map).length} 件）);
    return map;
　} catch (e) {
    Logger.log('グループCSV読み込み中にエラー発生: ' + e.message);
    return {}; // エラー時も空マップを返す
  }
  
  
}


function testGuest() {
  // var FIXED_FROM_DATE = new Date(2025,8,3); // monthは0からなんで-1
  // var FIXED_TO_DATE = new Date(2025,8,4);
  // var email = 'takaoka.daisuke@moneyforward.co.jp';
  var fromDate = FIXED_FROM_DATE;
  // var toDate = FIXED_TO_DATE.setHours(23, 59, 59, 999);
  var toDate = FIXED_TO_DATE;
  Logger.log('取得期間: %s ~ %s', fromDate.toISOString(), toDate.toISOString());

  // var email = 'ishihara.chiaki@moneyforward.co.jp';
  var email = 'yamada.taihei@moneyforward.co.jp';
  addMyCalenderToMyList(email);
  var cal = CalendarApp.getCalendarById(email);
  var events = cal.getEvents(FIXED_FROM_DATE, FIXED_TO_DATE);
  events.forEach(function(event){
    var guests = event.getGuestList();

    // Logger.log('event:%s, Creators:%s, guestCout:%s, startTime:%s, endTime:%s', event.getTitle() , event.getCreators(), guests.length, event.getStartTime(), event.getEndTime());
    // guests.forEach(function(guest){
    //   Logger.log('guestMail:%s, name:%s', guest.getEmail(), guest.getName());
    // })
    var guests = event.getGuestList();
    var guestEmails = (guests || []).map(function(g){ return g.getEmail(); }).filter(Boolean);
    var guestNames = (guests || []).map(function(g){ return g.getName(); }).filter(Boolean);
    var guestEmailsStr = guestEmails.join(';');
    var guestNamesStr = guestNames.join(';');
    Logger.log('event:%s, Creators:%s, guestCount:%s, startTime:%s, endTime:%s, guests:[%s], guestNames:[%s]', event.getTitle(), event.getCreators(), guestEmails.length, event.getStartTime(), event.getEndTime(), guestEmailsStr, guestNamesStr);

  })
}
/**
 * 本部・部署単位でスプレッドシートに書き込む安全版（重複生成防止 完全版）
 */
function runDivisionExportTrigger_BK() {
  const props = PropertiesService.getScriptProperties();
  const lastDivision = props.getProperty("lastProcessedDivision") || null;
  const lastDeptIndex = Number(props.getProperty("lastProcessedDeptIndex") || 0);

  Logger.log("▶ 本部部署単位安全自動処理開始");

  // --- フォルダ取得 ---
  // ROOT_FOLDER_NAME / FOLDER_NAME はメイン処理外側でセット済み
  let mainFolder;
  const rootFolders = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
  mainFolder = rootFolders.hasNext() ? rootFolders.next() : DriveApp.createFolder(ROOT_FOLDER_NAME);

  let outFolder;
  const monthFolders = mainFolder.getFoldersByName(FOLDER_NAME);
  outFolder = monthFolders.hasNext() ? monthFolders.next() : mainFolder.createFolder(FOLDER_NAME);

  // --- CSV読み込み ---
  const srcFolders = DriveApp.getFoldersByName(FOLDER_NAME);
  if (!srcFolders.hasNext()) return Logger.log(`❌ フォルダ "${FOLDER_NAME}" が見つかりません`);
  const srcFolder = srcFolders.next();

  const files = srcFolder.getFiles();
  let allRows = [];
  let headers = null;
  while (files.hasNext()) {
    const file = files.next();
    const name = file.getName();
    if (!name.startsWith("calendar_events_") || !name.endsWith(".csv")) continue;
    const rows = Utilities.parseCsv(file.getBlob().getDataAsString("UTF-8"));
    if (!headers) headers = rows[0];
    allRows.push(...rows.slice(1));
  }
  if (!headers || allRows.length === 0) return Logger.log("❌ CSVデータなし");

  const divIdx = headers.indexOf("本部・拠点");
  const deptIdx = headers.indexOf("部署");
  if (divIdx === -1 || deptIdx === -1) return Logger.log("❌ 本部または部署列なし");

  // --- 本部ごとに集約 ---
  const byDivision = {};
  allRows.forEach(r => {
    const div = (r[divIdx] || "その他").trim();
    if (!byDivision[div]) byDivision[div] = [];
    byDivision[div].push(r);
  });

  const divisions = Object.keys(byDivision).sort();
  let startDivIdx = lastDivision ? divisions.indexOf(lastDivision) : 0;

  if (startDivIdx >= divisions.length) {
    Logger.log("🎉 全本部処理完了");
    props.deleteProperty("lastProcessedDivision");
    props.deleteProperty("lastProcessedDeptIndex");
    divisions.forEach(d => props.deleteProperty(`divisionSheetId_${d}`));
    return;
  }

  const division = divisions[startDivIdx];
  const divRows = byDivision[division];
  Logger.log(`🏢 本部処理スタート: ${division} (${divRows.length}件)`);

  // --- スプレッドシート取得 or 作成 ---
  const ssIdProp = `divisionSheetId_${division}`;
  let ss = null;

  if (props.getProperty(ssIdProp)) {
    try { ss = SpreadsheetApp.openById(props.getProperty(ssIdProp)); } 
    catch (e) { Logger.log("PropertiesのID無効 → 新規作成へ"); }
  }

  if (!ss) {
    const lock = LockService.getScriptLock();
    lock.tryLock(30000);

    // 再チェックで既存確認
    let matchedFiles = outFolder.getFilesByName(`本部別_${division}`);
    if (matchedFiles.hasNext()) {
      ss = SpreadsheetApp.openById(matchedFiles.next().getId());
      Logger.log(`ロック後検索で既存利用: ${ss.getName()}`);
    } else {
      ss = SpreadsheetApp.create(`本部別_${division}`);
      const ssFile = DriveApp.getFileById(ss.getId());
      outFolder.addFile(ssFile);
      DriveApp.getRootFolder().removeFile(ssFile);
      Logger.log(`新規作成: ${ss.getName()}`);
    }

    props.setProperty(ssIdProp, ss.getId());
    lock.releaseLock();
  }

  // --- 部署ごとに書き込み ---
  const byDept = {};
  divRows.forEach(r => {
    const dept = (r[deptIdx] || "本部付").trim();
    if (!byDept[dept]) byDept[dept] = [];
    byDept[dept].push(r);
  });

  const depts = Object.keys(byDept).sort();
  const DIV_CHUNK_SIZE = 500;

  for (let i = lastDeptIndex; i < depts.length; i++) {
    const deptName = depts[i];
    const rows = byDept[deptName];

    const sheet =
      i === 0 && ss.getSheets()[0].getLastRow() === 0
        ? ss.getSheets()[0].setName(deptName)
        : ss.getSheetByName(deptName) || ss.insertSheet(deptName);

    if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

    for (let k = 0; k < rows.length; k += DIV_CHUNK_SIZE) {
      const chunk = rows.slice(k, k + DIV_CHUNK_SIZE);
      sheet.getRange(sheet.getLastRow() + 1, 1, chunk.length, headers.length).setValues(chunk);
      SpreadsheetApp.flush();
    }

    Logger.log(`📄 部署「${deptName}」出力完了: ${rows.length}行`);

    if (i < depts.length - 1 || startDivIdx < divisions.length - 1) {
      recreateDivisionTrigger("runDivisionExportTrigger", division, i + 1);
      Logger.log(`▶ 次回の再開地点: 本部=${division}, 次の部署=${depts[i + 1]}`);
      return;
    }
  }

  Logger.log(`✅ 本部完了: ${division}`);

  if (startDivIdx + 1 < divisions.length) {
    recreateDivisionTrigger("runDivisionExportTrigger", divisions[startDivIdx + 1], 0);
    Logger.log("▶ 次の本部用トリガー作成完了");

} else {
    Logger.log("🎉 全本部処理完了！！！");
    props.deleteProperty("lastProcessedDivision");
    props.deleteProperty("lastProcessedDeptIndex");
    divisions.forEach(d => props.deleteProperty(`divisionSheetId_${d}`));

    // ★★★ ここでサマリー生成 ★★★
    const ts = props.getProperty("ocr_last_export_ts");
    if (ts) {
      Logger.log("▶ 全本部完了 → サマリー生成開始: " + ts);
      try {
        aggregateCalendarEventPartsToSummary(ts);
        Logger.log("✅ サマリー生成完了");

        // 必要ならプロパティ削除
        props.deleteProperty("ocr_last_export_ts");
        cancelScheduledAggregation();

      } catch (e) {
        Logger.log("❌ サマリー生成エラー: " + e);
      }
    } else {
      Logger.log("⚠ サマリー生成用の exportTs が見つかりません");
    }
}

}



/**
 * トリガー再作成（安全版）
 */
function recreateDivisionTrigger(funcName, lastDivision, lastDeptIndex) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty("lastProcessedDivision", lastDivision);
  props.setProperty("lastProcessedDeptIndex", lastDeptIndex);

  // 古いトリガーを削除
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction && t.getHandlerFunction() === funcName) {
      ScriptApp.deleteTrigger(t);
    }
  });

  // 次回実行（60秒後） ← ★並列防止のため必須
  ScriptApp.newTrigger(funcName).timeBased().after(60 * 1000).create();
}

function safeRun(func, retry = 3, label = "") {
  for (let i = 0; i < retry; i++) {
    try {
      return func();
    } catch (e) {
      Logger.log(`⚠ safeRunエラー (${label}) [${i + 1}/${retry}] → ${e}`);
      Utilities.sleep(1500);
      if (i === retry - 1) throw e;
    }
  }
}
function runDivisionExportTrigger() {
  safeRun(() => runDivisionExportMain(), 3, "runDivisionExportMain");
}


function runDivisionExportMain() {
  const props = PropertiesService.getScriptProperties();
  const lastDivision = props.getProperty("lastProcessedDivision") || null;
  const lastDeptIndex = Number(props.getProperty("lastProcessedDeptIndex") || 0);

  Logger.log("▶ 本部部署単位安全自動処理開始");

  // --- フォルダ取得 ---
  let mainFolder = safeRun(() => {
    const rootFolders = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
    return rootFolders.hasNext()
      ? rootFolders.next()
      : DriveApp.createFolder(ROOT_FOLDER_NAME);
  }, 3, "get mainFolder");

  let outFolder = safeRun(() => {
    const monthFolders = mainFolder.getFoldersByName(FOLDER_NAME);
    return monthFolders.hasNext()
      ? monthFolders.next()
      : mainFolder.createFolder(FOLDER_NAME);
  }, 3, "get outFolder");

  // --- CSV読み込み ---
  const srcFolder = safeRun(() => {
  const monthFolders = mainFolder.getFoldersByName(FOLDER_NAME);
  if (!monthFolders.hasNext()) {
    throw new Error(`フォルダ "${FOLDER_NAME}" が見つかりません`);
  }
  const monthFolder = monthFolders.next();

  const eventFolders = monthFolder.getFoldersByName(EVENT_FOLDER_NAME);
  if (!eventFolders.hasNext()) {
    throw new Error(`イベントデータフォルダ "${EVENT_FOLDER_NAME}" が見つかりません`);
  }

  return eventFolders.next();
}, 3, "open event srcFolder");

  let allRows = [];
  let headers = null;

  const files = srcFolder.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    const name = file.getName();
    if (!name.startsWith("calendar_events_") || !name.endsWith(".csv")) continue;

    const rows = safeRun(
      () => Utilities.parseCsv(file.getBlob().getDataAsString("UTF-8")),
      3,
      "parseCsv"
    );

    if (!headers) headers = rows[0];
    allRows.push(...rows.slice(1));
  }

  if (!headers || allRows.length === 0) {
    Logger.log("❌ CSVデータなし");
    return;
  }

  const divIdx = headers.indexOf("本部・拠点");
  const deptIdx = headers.indexOf("部署");
  if (divIdx === -1 || deptIdx === -1) {
    Logger.log("❌ 本部または部署列なし");
    return;
  }

  // --- 本部ごとに集約 ---
  const byDivision = {};
  allRows.forEach(r => {
    const div = (r[divIdx] || "その他").trim();
    if (!byDivision[div]) byDivision[div] = [];
    byDivision[div].push(r);
  });

  const divisions = Object.keys(byDivision).sort();
  let startDivIdx = lastDivision ? divisions.indexOf(lastDivision) : 0;

  if (startDivIdx >= divisions.length) {
    Logger.log("🎉 全本部処理完了");
    props.deleteProperty("lastProcessedDivision");
    props.deleteProperty("lastProcessedDeptIndex");
    divisions.forEach(d => props.deleteProperty(`divisionSheetId_${d}`));
    return;
  }

  const division = divisions[startDivIdx];
  const divRows = byDivision[division];
  Logger.log(`🏢 本部処理スタート: ${division} (${divRows.length}件)`);

  // --- スプレッドシート取得 or 作成 ---
  const ssIdProp = `divisionSheetId_${division}`;
  let ss = null;

  if (props.getProperty(ssIdProp)) {
    ss = safeRun(() => SpreadsheetApp.openById(props.getProperty(ssIdProp)), 3, "open ss by ID");
  }

  if (!ss) {
    const lock = LockService.getScriptLock();
    safeRun(() => lock.tryLock(30000), 3, "lock");

    ss = safeRun(() => {
      let matchedFiles = outFolder.getFilesByName(`本部別_${division}`);
      if (matchedFiles.hasNext()) {
        Logger.log(`ロック後検索既存利用`);
        return SpreadsheetApp.openById(matchedFiles.next().getId());
      }
      Logger.log(`新規作成: 本部別_${division}`);
      const created = SpreadsheetApp.create(`本部別_${division}`);
      const ssFile = DriveApp.getFileById(created.getId());
      outFolder.addFile(ssFile);
      DriveApp.getRootFolder().removeFile(ssFile);
      return created;
    }, 3, "create/find ss");

    props.setProperty(ssIdProp, ss.getId());
    lock.releaseLock();
  }

  // --- 部署ごとに書き込み ---
  const byDept = {};
  divRows.forEach(r => {
    const dept = (r[deptIdx] || "本部付").trim();
    if (!byDept[dept]) byDept[dept] = [];
    byDept[dept].push(r);
  });

  const depts = Object.keys(byDept).sort();
  const DIV_CHUNK_SIZE = 500;

  for (let i = lastDeptIndex; i < depts.length; i++) {
    const deptName = depts[i];
    const rows = byDept[deptName];

    const sheet = safeRun(() => {
      if (i === 0 && ss.getSheets()[0].getLastRow() === 0)
        return ss.getSheets()[0].setName(deptName);

      return ss.getSheetByName(deptName) || ss.insertSheet(deptName);
    }, 3, "get or create sheet");

    if (sheet.getLastRow() === 0) {
      safeRun(() => sheet.getRange(1, 1, 1, headers.length).setValues([headers]), 3, "write header");
    }

    for (let k = 0; k < rows.length; k += DIV_CHUNK_SIZE) {
      const chunk = rows.slice(k, k + DIV_CHUNK_SIZE);
      safeRun(() => {
        sheet.getRange(sheet.getLastRow() + 1, 1, chunk.length, headers.length).setValues(chunk);
        SpreadsheetApp.flush();
      }, 3, "write chunk");
    }

    Logger.log(`📄 部署「${deptName}」出力完了: ${rows.length}行`);

    if (i < depts.length - 1 || startDivIdx < divisions.length - 1) {
      recreateDivisionTrigger("runDivisionExportTrigger", division, i + 1);
      Logger.log(`▶ 次回の再開: 本部=${division}, 部署=${depts[i + 1]}`);
      return;
    }
  }

  Logger.log(`✅ 本部完了: ${division}`);

  if (startDivIdx + 1 < divisions.length) {
    recreateDivisionTrigger("runDivisionExportTrigger", divisions[startDivIdx + 1], 0);
    Logger.log("▶ 次の本部処理へ");
  } else {
    Logger.log("🎉 全本部処理完了！！！");
    props.deleteProperty("lastProcessedDivision");
    props.deleteProperty("lastProcessedDeptIndex");
    divisions.forEach(d => props.deleteProperty(`divisionSheetId_${d}`));

    const ts = props.getProperty("ocr_last_export_ts");
    if (ts) {
      Logger.log("▶ サマリー生成開始: " + ts);
      safeRun(() => aggregateCalendarEventPartsToSummary(ts), 3, "aggregateSummary");
      Logger.log("✅ サマリー生成完了");
      markCompleted();
      props.deleteProperty("ocr_last_export_ts");
      cancelScheduledAggregation();
    } else {
      Logger.log("⚠ サマリー生成用TSなし");
    }
  }
}

function testsummary() {
aggregateCalendarEventPartsToSummary('20251204_113303')
}
