
function exportAllGroupsWithMembersToSheet() {
  const FOLDER_NAME = 'group_exports';
  const tz = Session.getScriptTimeZone();
  const ts = Utilities.formatDate(new Date(), tz, 'yyyyMMdd_HHmmss');
  const sheetName = `groups_members_${ts}`;

  // 出力先フォルダを取得 or 作成
  let folder;
  const folders = DriveApp.getFoldersByName(FOLDER_NAME);
  folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(FOLDER_NAME);

  // スプレッドシートを新規作成
  const ss = SpreadsheetApp.create(sheetName);
  const sheet = ss.getActiveSheet();
  sheet.clear();

  // CSVヘッダ
  const headers = ['グループアドレス', 'メンバー数', 'メンバー一覧（セミコロン区切り）'];
  sheet.appendRow(headers);

  let pageToken;

  do {
    const response = AdminDirectory.Groups.list({
      customer: 'my_customer',
      maxResults: 200,
      pageToken: pageToken
    });

    const groups = response.groups || [];

    groups.forEach(group => {
      const groupEmail = group.email;
      let allMembers = [];

      let memberPageToken;
      do {
        try {
          const membersResponse = AdminDirectory.Members.list(groupEmail, {
            maxResults: 200,
            pageToken: memberPageToken
          });
          const members = membersResponse.members || [];
          allMembers = allMembers.concat(members.map(m => m.email || ''));
          memberPageToken = membersResponse.nextPageToken;
        } catch (e) {
          Logger.log(`⚠️ グループ ${groupEmail} のメンバー取得でエラー: ${e}`);
          memberPageToken = null;
        }
      } while (memberPageToken);

      const memberCount = allMembers.length;
      const memberList = allMembers.join(';');

      // スプレッドシートに1行追加
      sheet.appendRow([groupEmail, memberCount, memberList]);
    });

    pageToken = response.nextPageToken;
  } while (pageToken);

  // 出力フォルダへ移動
  const file = DriveApp.getFileById(ss.getId());
  folder.addFile(file);
  DriveApp.getRootFolder().removeFile(file); // My Driveから除外（任意）

  Logger.log('✅ スプレッドシート作成完了: ' + ss.getUrl());
}

/**
 * CSVセル内のカンマ・改行・ダブルクォートを適切にエスケープ
 */
function escapeCsvCell(value) {
  if (value == null) return '';
  let str = String(value);
  if (/[",\r\n]/.test(str)) {
    str = '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}



/**
 * group_exports フォルダ内のグループ一覧スプレッドシートを統合
 * ・グループアドレスで重複排除
 * ・メンバーは和集合でマージ
 */
function mergeGroupExportSheetsDedup() {
  const FOLDER_NAME = 'group_exports';
  const tz = Session.getScriptTimeZone();
  const ts = Utilities.formatDate(new Date(), tz, 'yyyyMMdd_HHmmss');
  const mergedSheetName = `groups_members_merged_${ts}`;

  // --- フォルダ取得 ---
  const folders = DriveApp.getFoldersByName(FOLDER_NAME);
  if (!folders.hasNext()) {
    Logger.log('❌ group_exports フォルダが見つかりません');
    return;
  }
  const folder = folders.next();

  // --- 集約用マップ ---
  // groupEmail -> Set(memberEmail)
  const groupMap = {};

  // --- フォルダ内スプレッドシート走査 ---
  const files = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  while (files.hasNext()) {
    const file = files.next();
    const ss = SpreadsheetApp.openById(file.getId());
    const sheet = ss.getSheets()[0]; // 先頭シート想定

    const values = sheet.getDataRange().getValues();
    if (values.length <= 1) continue;

    // ヘッダ位置を特定
    const header = values[0];
    const groupIdx  = header.indexOf('グループアドレス');
    const memberIdx = header.indexOf('メンバー一覧（セミコロン区切り）');

    if (groupIdx === -1 || memberIdx === -1) {
      Logger.log(`⚠️ ヘッダ不正のためスキップ: ${file.getName()}`);
      continue;
    }

    // データ行処理
    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      const groupEmail = String(row[groupIdx] || '').trim();
      if (!groupEmail) continue;

      const membersStr = String(row[memberIdx] || '').trim();
      const members = membersStr
        ? membersStr.split(';').map(m => m.trim()).filter(Boolean)
        : [];

      if (!groupMap[groupEmail]) {
        groupMap[groupEmail] = new Set();
      }

      members.forEach(m => groupMap[groupEmail].add(m));
    }
  }

  // --- 出力スプレッドシート作成 ---
  const mergedSS = SpreadsheetApp.create(mergedSheetName);
  const mergedSheet = mergedSS.getActiveSheet();
  mergedSheet.clear();

  // ヘッダ
  mergedSheet.appendRow([
    'グループアドレス',
    'メンバー数',
    'メンバー一覧（セミコロン区切り）'
  ]);

  // データ出力（グループアドレス順）
  const groupEmails = Object.keys(groupMap).sort();
  groupEmails.forEach(groupEmail => {
    const members = Array.from(groupMap[groupEmail]).sort();
    mergedSheet.appendRow([
      groupEmail,
      members.length,
      members.join(';')
    ]);
  });

  // --- フォルダへ移動 ---
  const mergedFile = DriveApp.getFileById(mergedSS.getId());
  folder.addFile(mergedFile);
  DriveApp.getRootFolder().removeFile(mergedFile);

  Logger.log(`✅ 統合完了（重複排除済み）: ${mergedSheetName}`);
  Logger.log(`📊 グループ数: ${groupEmails.length}`);
}

