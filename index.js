'use strict';
require('dotenv').config();

const {
  Client, GatewayIntentBits, Events,
  REST, Routes, SlashCommandBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  PermissionFlagsBits, ChannelType, AttachmentBuilder
} = require('discord.js');
const dayjs = require('dayjs');
const fs = require('node:fs/promises');
const fssync = require('node:fs');

// =============== ENV =================
const TOKEN        = (process.env.TOKEN || process.env.DISCORD_TOKEN || '').trim();
const CLIENT_ID    = (process.env.CLIENT_ID || '').trim();
const GUILD_ID     = (process.env.GUILD_ID || '').trim();

const SPREADSHEET_ID   = process.env.SPREADSHEET_ID;
const SHEET_QUESTIONS  = process.env.SHEET_QUESTIONS || 'questions';
const SHEET_VOTER_DATA = process.env.SHEET_VOTER_DATA || 'voter_data';

const GS_ENABLED = String(process.env.GOOGLE_SHEETS_ENABLED || 'true').toLowerCase() === 'true';

// Normalize the private key ONCE (handles quotes and both "\n" / "\\n")
const GS_EMAIL = process.env.GOOGLE_SERVICE_EMAIL || '';
const GS_PRIVATE = (() => {
  let k = (process.env.GOOGLE_PRIVATE_KEY || '').trim();
  // strip wrapping quotes if present
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1);
  }
  // turn \n and \\n into real newlines
  k = k.replace(/\\\\n/g, '\n').replace(/\\n/g, '\n');
  return k;
})();

// Safety
if (!TOKEN || TOKEN.length < 30) {
  console.error('❌ Missing/invalid TOKEN. Set env TOKEN or DISCORD_TOKEN to a valid bot token (no "Bot " prefix).');
  process.exit(1);
}
if (!CLIENT_ID || !GUILD_ID) {
  console.error('❌ Missing CLIENT_ID or GUILD_ID in .env');
}
if (GS_ENABLED && (!SPREADSHEET_ID || !GS_EMAIL || !GS_PRIVATE)) {
  console.error('❌ Missing Google Sheets credentials/ids in .env');
}

// ============== iMatch / Pairing Bot ENV and constants ==============
const PRIVATE_CATEGORY_ID = process.env.PRIVATE_CATEGORY_ID || '1405067168231456859';
const GROUP_CATEGORY_ID = process.env.GROUP_CATEGORY_ID || '1405068096309432343';

const STAFF_CHANNEL_ID = process.env.STAFF_CHANNEL_ID || '1407539557343166474';
const REQUEST_CHANNEL_ID = process.env.REQUEST_CHANNEL_ID || '1407539344805204018';
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID || '1406318326464118836';

const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || null;

// iTalk source: Column A of tab "italk card"
const ITALK_GSHEET_ID = process.env.ITALK_GSHEET_ID || '1mMwL4gDzSK7_Tr7Ibrqm7Oz6Sj9y3ZJBa3kPhNqbB3Y';
const ITALK_GSHEET_RANGE = process.env.ITALK_GSHEET_RANGE || `'italk card'!A:A`;

// Register sheet: tab "register"
const REG_GSHEET_ID = process.env.GSHEET_ID || '1j0vgpwDd40rPW_NnvQE3FcsCtt7mTaY0HR2Pg4uvcvc';
const REG_GSHEET_RANGE = process.env.GSHEET_RANGE || `'register'!A:Z`;

// Votes sheet: tab "voter_data"
const VOTE_GSHEET_ID = process.env.VOTE_GSHEET_ID || '1mMwL4gDzSK7_Tr7Ibrqm7Oz6Sj9y3ZJBa3kPhNqbB3Y';
const VOTE_GSHEET_RANGE = process.env.VOTE_GSHEET_RANGE || `'voter_data'!A:Z`;

// MBTI cache
const MBTI_MATRIX_PATH = process.env.MBTI_MATRIX_PATH || './mbti_matrix.json';

// Match lifetime / extend
const MATCH_LIFETIME_HOURS = Number(process.env.MATCH_LIFETIME_HOURS || 48);

// Limits: role-based
const ROLE_LIMITED_ID = process.env.ROLE_LIMITED_ID || '1403184256603131966';

// Request Quota
const DEFAULT_REQUEST_LIMITS = { maxRequests: 0, maxSuccess: 0 };
const ROLE_REQUEST_LIMITS = { [ROLE_LIMITED_ID]: { maxRequests: 3, maxSuccess: 1 } };

// iTalk Card Quota
const DEFAULT_ITALK_LIMITS = { maxPerDay: 0 };
const ROLE_ITALK_LIMITS = { [ROLE_LIMITED_ID]: { maxPerDay: 1 } };

// Decide intro starter (male starts)
const ROLE_MALE_ID = process.env.ROLE_MALE_ID || '1404777678292254792';

// =================== Google Sheets ===================
const { google } = require('googleapis');

let sheets = null;
(async () => {
  try {
    if (!GS_ENABLED) {
      console.log('ℹ️ Google Sheets disabled by env');
      return;
    }
    const auth = new google.auth.JWT(
      GS_EMAIL,
      null,
      GS_PRIVATE,
      ['https://www.googleapis.com/auth/spreadsheets']
    );
    // force initial token acquisition to catch key issues early
    await auth.authorize();
    sheets = google.sheets({ version: 'v4', auth });
    console.log('✅ Google Sheets ready');
  } catch (err) {
    console.error('❌ Failed to init Google Sheets', err?.response?.data || err);
  }
})();

// ============== iMatch store and helpers ==============
const STORE_PATH = './match_store.json';
let store = {
  totalMatches: 0,
  perUser: {},
  activity: {},
  profiles: {},
  pendingRequests: {},
  cupidBatches: {},
  matchedPairs: {},
  roomUsage: {}
};

async function loadStore() {
  try {
    const data = JSON.parse(await fs.readFile(STORE_PATH, 'utf8'));
    store = { ...store, ...data };
    // migrate old italkUsed to italkUsage if present
    for (const channelId in store.roomUsage) {
      if (store.roomUsage[channelId].italkUsed && !store.roomUsage[channelId].italkUsage) {
        store.roomUsage[channelId].italkUsage = {};
        for (const uid in store.roomUsage[channelId].italkUsed) {
          store.roomUsage[channelId].italkUsage[uid] = { lastUsedDate: null, count: 0 };
        }
        delete store.roomUsage[channelId].italkUsed;
      }
    }
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log('✅ match_store.json not found, initializing new store.');
      await saveStore();
    } else {
      console.error('❌ Failed to load store, re-initializing. Error:', e.message);
      await saveStore();
    }
  }
}
async function saveStore() {
  await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2));
}
const periodKey = (d = new Date()) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

function getRoleLimits(member) {
  let lim = { ...DEFAULT_REQUEST_LIMITS };
  for (const [rid, cfg] of Object.entries(ROLE_REQUEST_LIMITS)) {
    if (member.roles.cache.has(rid)) {
      lim.maxRequests = Math.min(lim.maxRequests, cfg.maxRequests);
      lim.maxSuccess = Math.min(lim.maxSuccess, cfg.maxSuccess);
    }
  }
  return lim;
}
function getUserMonth(uid, pk = periodKey()) {
  store.perUser[uid] ??= {};
  store.perUser[uid][pk] ??= { requests: 0, success: 0 };
  return store.perUser[uid][pk];
}
function getUserCounts(member) {
  const lim = getRoleLimits(member);
  const cur = getUserMonth(member.id);
  return {
    limits: lim,
    used: { ...cur },
    remaining: {
      requestsRemaining: Math.max(0, lim.maxRequests - cur.requests),
      successRemaining: Math.max(0, lim.maxSuccess - cur.success)
    }
  };
}
async function incRequest(uid) {
  const m = getUserMonth(uid);
  m.requests++;
  await saveStore();
  return m.requests;
}
async function incSuccess(uids) {
  const pk = periodKey();
  for (const uid of uids) {
    store.perUser[uid] ??= {};
    store.perUser[uid][pk] ??= { requests: 0, success: 0 };
    store.perUser[uid][pk].success++;
  }
  store.totalMatches = (store.totalMatches || 0) + 1;
  await saveStore();
}
const pairKey = (a, b) => [a, b].sort().join('-');
function rememberPair(a, b) {
  store.matchedPairs ??= {};
  store.matchedPairs[pairKey(a, b)] = new Date().toISOString();
  saveStore();
}
const everPaired = (a, b) => {
  store.matchedPairs ??= {};
  return !!store.matchedPairs[pairKey(a, b)];
};
function setPendingRequest(a, b) {
  store.pendingRequests ??= {};
  const k = `${a}-${b}`;
  store.pendingRequests[k] = {
    requesterId: a,
    targetId: b,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + MATCH_LIFETIME_HOURS * 3600 * 1000).toISOString()
  };
  return saveStore();
}
function clearPendingRequest(a, b) {
  store.pendingRequests ??= {};
  delete store.pendingRequests[`${a}-${b}`];
  return saveStore();
}
const isRequestActive = (a, b) => {
  store.pendingRequests ??= {};
  const r = store.pendingRequests[`${a}-${b}`];
  return r && Date.now() <= Date.parse(r.expiresAt || 0);
};

// ====== Question bank ======
let questionBank = [];

/**
 * Load rows from the questions sheet. Expects a header row containing:
 * question_a, question_b, category (optional), is_active (optional)
 */
async function loadQuestionsFromSheet() {
  try {
    if (!GS_ENABLED || !sheets) {
      questionBank = [];
      console.log('ℹ️ Sheets disabled or not ready; questionBank cleared.');
      return 0;
    }

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: SHEET_QUESTIONS, // whole sheet
    });

    const values = res.data.values || [];
    if (!values.length) {
      questionBank = [];
      console.log('ℹ️ Questions sheet empty.');
      return 0;
    }

    const header = values[0].map(h => String(h || '').trim().toLowerCase());
    const idxA = header.indexOf('question_a');
    const idxB = header.indexOf('question_b');
    const idxC = header.indexOf('category');
    const idxActive = header.indexOf('is_active');

    if (idxA === -1 || idxB === -1) {
      questionBank = [];
      console.log('ℹ️ Header must include question_a and question_b.');
      return 0;
    }

    questionBank = values.slice(1).map(r => {
      const a = String(r[idxA] || '').trim();
      const b = String(r[idxB] || '').trim();
      const category = idxC >= 0 ? String(r[idxC] || '').trim() : '';
      const isActive = idxActive >= 0 ? String(r[idxActive] || '').toLowerCase() !== 'false' : true;
      return { question_a: a, question_b: b, category, is_active: isActive };
    }).filter(x => x.question_a && x.question_b && x.is_active);

    console.log(`✅ Loaded ${questionBank.length} questions from sheet`);
    return questionBank.length;
  } catch (err) {
    console.error('❌ loadQuestionsFromSheet failed:', err?.response?.data || err);
    // keep the bot alive even if sheets fails
    questionBank = [];
    return 0;
  }
}

// Append to voter_data (best-effort; never throw)
async function appendVoterRow(obj) {
  try {
    if (!GS_ENABLED || !sheets) return;
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: SHEET_VOTER_DATA,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [Object.values(obj)] },
    });
  } catch (err) {
    console.error('❌ appendVoterRow failed:', err?.response?.data || err);
  }
}

// ====== Discord setup ======
const client = new Client({ intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.DirectMessages,
  GatewayIntentBits.GuildMessageReactions
] });

// Track user activity on message for 7-day active filter
client.on('messageCreate', async (m) => {
  if (!m.guild || m.author.bot) return;
  store.activity[m.author.id] = new Date().toISOString();
  await saveStore();
});
const isActiveIn7Days = (uid, now = Date.now()) => {
  store.activity ??= {};
  const iso = store.activity?.[uid];
  if (!iso) return false;
  const t = Date.parse(iso) || 0;
  return now - t <= 7 * 24 * 3600 * 1000;
};

async function registerCommands() {
  const pollCommands = [
    new SlashCommandBuilder()
      .setName('poll-now')
      .setDescription('立即發佈 2 選 1 投票（隨機）')
      .addIntegerOption(o =>
        o.setName('duration')
         .setDescription('投票時長（分鐘；預設120）')
         .setMinValue(1).setMaxValue(1440)
      ),

    new SlashCommandBuilder()
      .setName('poll-activity')
      .setDescription('依分類發佈 2 選 1 投票')
      .addStringOption(o =>
        o.setName('category')
         .setDescription('分類')
         .setRequired(true)
         .addChoices(
           { name: 'hk-life', value: 'hk-life' },
           { name: 'entertainment', value: 'entertainment' },
           { name: 'work', value: 'work' },
           { name: 'food', value: 'food' },
         )
      )
      .addIntegerOption(o =>
        o.setName('duration')
         .setDescription('投票時長（分鐘；預設120）')
         .setMinValue(1).setMaxValue(1440)
      ),

    new SlashCommandBuilder()
      .setName('results-now')
      .setDescription('顯示本頻道最近一次投票結果'),

    new SlashCommandBuilder()
      .setName('reload-questions')
      .setDescription('重新讀取題庫（Google Sheet）'),
  ].map(c => c.toJSON());

  // iMatch command definitions (object form)
  const imatchCommands = [{
    name: 'match',
    description: '（管理）立即為兩人開私房',
    default_member_permissions: (PermissionFlagsBits.Administrator).toString(),
    options: [
      { name: 'user1', description: '成員 1', type: 6, required: true },
      { name: 'user2', description: '成員 2', type: 6, required: true }
    ]
  }, {
    name: 'match_request',
    description: '向某人發起配對邀請',
    options: [
      { name: 'user', description: '你想配對嘅對象', type: 6, required: true }
    ]
  }, {
    name: 'endmatch',
    description: '（房內使用）提前關閉你的配對房'
  }, {
    name: 'extend',
    description: '（房內使用）將此房延長 48 小時（每房一次）'
  }, {
    name: 'italkcard',
    description: '抽一張 iTalk Card'
  }, {
    name: 'groupchat',
    description: '（管理）建立多人成員的私密群組房',
    default_member_permissions: (PermissionFlagsBits.ManageChannels).toString(),
    options: [...Array.from({ length: 10 }, (_, i) => ({ name: `user${i+1}`, description: `成員 ${i+1}`, type: 6, required: i < 3 }))]
  }, {
    name: 'cupid_preview',
    description: '（管理）生成 Cupid 配對清單供審批（不會開房）',
    default_member_permissions: (PermissionFlagsBits.Administrator).toString()
  }, {
    name: 'cupid_approve',
    description: '（管理）批准並開房',
    default_member_permissions: (PermissionFlagsBits.Administrator).toString(),
    options: [
      { name: 'batch_id', description: '預覽批次 ID', type: 3, required: true },
      { name: 'indices', description: '序號（1,3,5）留空=全部', type: 3 }
    ]
  }, {
    name: 'pair',
    description: '（管理）選取一個特定的配對並開房',
    default_member_permissions: (PermissionFlagsBits.Administrator).toString(),
    options: [
      { name: 'batch_id', description: '預覽批次 ID', type: 3, required: true },
      { name: 'pair_id', description: '配對序號', type: 4, required: true }
    ]
  }, {
    name: 'sync_profiles',
    description: '（管理）由 Google Sheet 同步用戶資料',
    default_member_permissions: (PermissionFlagsBits.Administrator).toString()
  }, {
    name: 'italk_reload',
    description: '（管理）重新載入 iTalk 卡片',
    default_member_permissions: (PermissionFlagsBits.Administrator).toString()
  }, {
    name: 'health',
    description: '（管理）健康檢查',
    default_member_permissions: (PermissionFlagsBits.Administrator).toString()
  }, {
    name: 'check_profiles',
    description: '（管理）檢查特定成員的配對資料',
    default_member_permissions: (PermissionFlagsBits.Administrator).toString(),
    options: [{ name: 'user', description: '要檢查的成員', type: 6, required: true }]
  }];

  const allCommands = [...pollCommands, ...imatchCommands];
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: allCommands });
  console.log('✅ Slash commands registered');
}

function summarizeVotes(votesMap) {
  let a = 0, b = 0;
  for (const v of votesMap.values()) {
    if (v === 'A') a++;
    else if (v === 'B') b++;
  }
  const total = a + b;
  const pa = total ? Math.round((a / total) * 100) : 0;
  const pb = total ? 100 - pa : 0;
  return { a, b, total, pa, pb };
}

function buildPollButtons(q, msgId) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`vote:A:${msgId}`)
      .setStyle(ButtonStyle.Success)
      .setLabel(`投 A：${q.question_a}`),
    new ButtonBuilder()
      .setCustomId(`vote:B:${msgId}`)
      .setStyle(ButtonStyle.Primary)
      .setLabel(`投 B：${q.question_b}`),
    new ButtonBuilder()
      .setCustomId(`result:${msgId}`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('查看結果'),
  );
  return [row];
}

// track live polls by message id & by channel
const livePolls = new Map();
const lastPollByChannel = new Map();

async function createPoll(channel, q, { replyTo = null, durationMins = 120 } = {}) {
  const endsAt = dayjs().add(durationMins, 'minute');

  const embed = new EmbedBuilder()
    .setTitle('每日 2 選 1 投票')
    .setDescription(`A：**${q.question_a}**\nB：**${q.question_b}**`)
    .setFooter({ text: `分類：${q.category || '—'}｜剩餘 ${durationMins} 分鐘` });

  const temp = await channel.send({ embeds: [embed], components: buildPollButtons(q, 'temp') });
  await temp.edit({ components: buildPollButtons(q, temp.id) });

  const state = {
    messageId: temp.id,
    channelId: channel.id,
    q, createdAt: dayjs(), expiresAt: endsAt, votes: new Map(),
  };
  livePolls.set(temp.id, state);
  lastPollByChannel.set(channel.id, state);

  // log creation (best-effort)
  appendVoterRow({
    event_type: 'poll_created',
    timestamp: new Date().toISOString(),
    poll_id: '',
    message_id: temp.id,
    channel_id: channel.id,
    question_a: q.question_a,
    question_b: q.question_b,
    tag: q.tag || '',
    user_id: '',
    username: '',
    choice: '',
    votes_a: 0,
    votes_b: 0,
    percent_a: '0%',
    percent_b: '0%',
    total_votes: 0,
    poll_start: state.createdAt.toISOString(),
    poll_end: state.expiresAt.toISOString(),
    poll_duration_hours: (durationMins / 60).toFixed(2),
  });

  // collector
  const collector = temp.createMessageComponentCollector({ time: durationMins * 60 * 1000 });

  collector.on('collect', async (interaction) => {
    try {
      if (interaction.customId.startsWith('vote:')) {
        const [, choice, mid] = interaction.customId.split(':');
        if (mid !== temp.id) return interaction.deferUpdate();

        const already = state.votes.get(interaction.user.id);
        if (already === choice) {
          return interaction.reply({ content: `你已經投了 **${choice}**`, ephemeral: true });
        }
        state.votes.set(interaction.user.id, choice);

        const { a, b, total, pa, pb } = summarizeVotes(state.votes);
        appendVoterRow({
          event_type: 'vote',
          timestamp: new Date().toISOString(),
          poll_id: '',
          message_id: temp.id,
          channel_id: channel.id,
          question_a: q.question_a,
          question_b: q.question_b,
          tag: q.tag || '',
          user_id: interaction.user.id,
          username: interaction.user.username,
          choice,
          votes_a: a, votes_b: b,
          percent_a: `${pa}%`, percent_b: `${pb}%`,
          total_votes: total,
          poll_start: state.createdAt.toISOString(),
          poll_end: state.expiresAt.toISOString(),
          poll_duration_hours: ((state.expiresAt.diff(state.createdAt, 'minute')) / 60).toFixed(2),
        });

        await interaction.reply({ content: `你投了 **${choice}**`, ephemeral: true });
      } else if (interaction.customId.startsWith('result:')) {
        const { a, b, total, pa, pb } = summarizeVotes(state.votes);
        await interaction.reply({
          content: `目前結果：A **${a}** (${pa}%) ｜ B **${b}** (${pb}%) ｜ 共 **${total}** 票`,
          ephemeral: true,
        });
      } else {
        await interaction.deferUpdate();
      }
    } catch {}
  });

  collector.on('end', async () => {
    const { a, b, total, pa, pb } = summarizeVotes(state.votes);
    const final = new EmbedBuilder()
      .setTitle('投票已結束')
      .setDescription(
        `A：**${q.question_a}**\nB：**${q.question_b}**\n\n最終結果：A **${a}** (${pa}%) ｜ B **${b}** (${pb}%) ｜ 共 **${total}** 票`
      )
      .setFooter({ text: `分類：${q.category || '—'}` });
    try { await temp.edit({ embeds: [final], components: [] }); } catch {}
    livePolls.delete(temp.id);
  });

  if (replyTo) {
    try { await replyTo.editReply(`已在 #${channel.name} 發佈投票。`); } catch {}
  }
}

// ====== Ready + Interactions ======
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  await loadQuestionsFromSheet().catch(() => {});
  await registerCommands().catch(err => console.error('❌ Command register error:', err?.response?.data || err));
  // iMatch initializations
  await loadStore().catch(() => {});
  await loadMbtiCacheJSON().catch(() => {});
  await loadItalkFromGoogleSheet().catch(() => {});
  await loadVotesFromSheet().catch(() => {});
  try {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (guild) await guild.members.fetch();
  } catch {}
  setInterval(() => {
    const g = client.guilds.cache.get(GUILD_ID);
    if (g) sweepExpiredRooms(g);
  }, CLOSE_SWEEP_INTERVAL_MS);
});

// All interactions
client.on(Events.InteractionCreate, async i => {
  try {
    if (!i.isChatInputCommand()) return;
    const name = i.commandName;

    if (name === 'reload-questions') {
      await i.deferReply({ ephemeral: true });
      const n = await loadQuestionsFromSheet();
      await i.editReply(`題庫已載入：${n} 題`);
      return;
    }

    if (name === 'results-now') {
      const state = lastPollByChannel.get(i.channelId);
      if (!state) {
        return i.reply({ content: '此頻道未找到最近的投票。', ephemeral: true });
      }
      const { a, b, total, pa, pb } = summarizeVotes(state.votes);
      return i.reply({
        content: `目前結果：A **${a}** (${pa}%) ｜ B **${b}** (${pb}%) ｜ 共 **${total}** 票`,
        ephemeral: true
      });
    }

    if (name === 'poll-now') {
      await i.deferReply({ ephemeral: true });
      if (!questionBank || !questionBank.length) return i.editReply('題庫為空（請先 /reload-questions）');
      const duration = i.options.getInteger('duration') ?? 120;
      const q = questionBank[Math.floor(Math.random() * questionBank.length)];
      await createPoll(i.channel, q, { replyTo: i, durationMins: duration });
      return;
    }

    if (name === 'poll-activity') {
      await i.deferReply({ ephemeral: true });
      const category = (i.options.getString('category') || 'entertainment').toLowerCase();
      const duration = i.options.getInteger('duration') ?? 120;
      const pool = (questionBank || []).filter(r => (r.category || '').toLowerCase() === category);
      if (!pool.length) return i.editReply(`找不到分類 **${category}** 的題目。`);
      const q = pool[Math.floor(Math.random() * pool.length)];
      await createPoll(i.channel, q, { replyTo: i, durationMins: duration });
      return;
    }

    // ================= iMatch Commands =================
    if (name === 'match') {
      if (!i.member.permissions.has(PermissionFlagsBits.Administrator))
        return i.reply({ content: '沒有權限。', ephemeral: true });
      const u1 = i.options.getUser('user1', true);
      const u2 = i.options.getUser('user2', true);
      if (u1.id === u2.id) return i.reply({ content: '請選擇兩個不同成員。', ephemeral: true });
      const exist = await findExistingPairRoom(i.guild, u1.id, u2.id);
      if (exist) return i.reply({ content: `你哋已有配對房：${exist}`, ephemeral: true });
      const ch = await createPrivateRoom(i.guild, u1, u2);
      rememberPair(u1.id, u2.id);
      await incSuccess([u1.id, u2.id]).catch(() => {});
      await announceNewMatch(i.guild).catch(() => {});
      return i.reply({ content: `已建立：${ch}`, ephemeral: true });
    }

    if (name === 'match_request') {
      const target = i.options.getUser('user', true);
      const requester = i.user;
      if (target.id === requester.id)
        return i.reply({ content: '你唔可以同自己配對 🙃', ephemeral: true });
      const guild = i.guild;
      const memberTarget = await guild.members.fetch(target.id).catch(() => null);
      if (!memberTarget) return i.reply({ content: '對方不在此伺服器。', ephemeral: true });
      const memberReq = await guild.members.fetch(requester.id).catch(() => null);
      const q = getUserCounts(memberReq);
      if (q.remaining.requestsRemaining <= 0) return i.reply({ content: '你本月的配對申請次數已用完。', ephemeral: true });
      if (q.remaining.successRemaining <= 0) return i.reply({ content: '你本月已達到成功配對上限。', ephemeral: true });
      const exist = await findExistingPairRoom(guild, requester.id, target.id);
      if (exist) return i.reply({ content: `你哋已有配對房：${exist}`, ephemeral: true });

      const reqKey = `${requester.id}-${target.id}`;
      if (store.pendingRequests[reqKey]) {
        return i.reply({ content: `你已經向 <@${target.id}> 發出過配對請求，請耐心等候。`, ephemeral: true });
      }

      await incRequest(requester.id);
      await setPendingRequest(requester.id, target.id);
      const counts = getUserCounts(memberReq);
      await i.reply({ content: `✅ 已向 <@${target.id}> 發出配對請求。 ${counts.remaining.requestsRemaining} 次申請尚餘。`, ephemeral: true });

      const embed = new EmbedBuilder().setTitle('iMatch 配對請求').setDescription(`**${requester.username}** 想同你配對！`).setColor('Blurple');
      try {
        await memberTarget.send({ embeds: [embed], components: [consentRow(reqKey)] });
        const staff = await getStaffChannel(guild);
        if (staff) staff.send(`配對請求已發出: <@${requester.id}> -> <@${target.id}>`);
      } catch (e) {
        if (e.code === 50007) {
          const staff = await getStaffChannel(guild);
          if (staff) staff.send(`⚠️ 無法 DM <@${target.id}> (私訊關閉)，無法傳送配對請求`);
          return i.followUp({ content: `❌ 無法 DM <@${target.id}>，請通知對方開啟私訊。`, ephemeral: true });
        }
        throw e;
      }
      return;
    }

    if (name === 'endmatch') {
      const { channel } = i;
      if (channel.type !== ChannelType.GuildText || !channel.topic?.startsWith('PAIR:')) {
        return i.reply({ content: '此指令只能在配對房間內使用。', ephemeral: true });
      }
      const pair = channel.topic.match(/PAIR:(\d+-\d+)/)?.[1]?.split('-').sort();
      if (!pair || !pair.includes(i.user.id)) {
        return i.reply({ content: '你沒有權限關閉此房間。', ephemeral: true });
      }
      await i.reply({ content: '房間將在 5 秒後關閉...', ephemeral: false });
      setTimeout(async () => { try { await channel.delete('iMatch endmatch command'); } catch {} }, 5000);
      return;
    }

    if (name === 'extend') {
      const { channel } = i;
      if (channel.type !== ChannelType.GuildText || !channel.topic?.startsWith('PAIR:')) {
        return i.reply({ content: '此指令只能在配對房間內使用。', ephemeral: true });
      }
      if (!markExtended(channel.id)) {
        return i.reply({ content: '此房間已經延長過一次了。', ephemeral: true });
      }
      const topic = channel.topic || '';
      const createdAtMs = parseCreatedAtFromTopic(topic) ?? channel.createdTimestamp;
      const newExpiry = new Date(createdAtMs + 2 * MATCH_LIFETIME_HOURS * 3600 * 1000).toISOString();
      await channel.edit({ topic: topic.replace(/Created:.*?(?=\s)/, `Created:${newExpiry}`) });
      await i.reply({ content: `✅ 房間已成功延長 **${MATCH_LIFETIME_HOURS} 小時**。` });
      return;
    }

    if (name === 'italkcard') {
      const { channel, member } = i;
      const { ok, used, left, msg } = canUseItalk(channel.id, i.user.id, member);
      if (!ok) return i.reply({ content: msg || `你已用完本房間的 iTalk 卡片額度（已使用: ${used}/${used + left}, 尚餘: ${left}）`, ephemeral: true });
      await markItalkUsed(channel.id, i.user.id);
      const card = pickItalkCard();
      await i.reply({ content: `🃏 你抽到了一張 iTalk Card：${card}` });
      return;
    }

    if (name === 'italk_reload') {
      if (!i.member.permissions.has(PermissionFlagsBits.Administrator)) return i.reply({ content: '沒有權限。', ephemeral: true });
      await i.deferReply();
      const ok = await loadItalkFromGoogleSheet();
      await i.editReply(ok ? `✅ 已重新載入 iTalk 卡片：共 ${ITALK_QUESTIONS.length} 張。` : '❌ 重新載入失敗，請檢查 Google Sheet 設定。');
      return;
    }

    if (name === 'groupchat') {
      if (!i.member.permissions.has(PermissionFlagsBits.ManageChannels)) return i.reply({ content: '沒有權限。', ephemeral: true });
      const users = [];
      for (let idx = 1; idx <= 10; idx++) {
        const user = i.options.getUser(`user${idx}`);
        if (user) users.push(user);
      }
      if (users.length < 2) return i.reply({ content: '請至少選擇 2 位成員。', ephemeral: true });
      await i.deferReply();
      const ch = await createGroupRoom(i.guild, users);
      await i.editReply(`✅ 已建立群組房：${ch}`);
      return;
    }

    if (name === 'cupid_preview') {
      if (!i.member.permissions.has(PermissionFlagsBits.Administrator)) return i.reply({ content: '沒有權限。', ephemeral: true });
      await i.deferReply();
      const pairs = await computeCupidPairs(i.guild);
      if (!pairs.length) return i.editReply('❌ 沒有找到合適的配對。');
      const batchId = Date.now().toString(36);
      store.cupidBatches[batchId] = { createdAt: new Date().toISOString(), pairs };
      await saveStore();

      let preview = `**Cupid 配對預覽批次 ID：${batchId}**\n\n`;
      let csvContent = `Index,User1 ID,User1 Name,User2 ID,User2 Name,Score,Notes\n`;
      const promises = [];
      for (let k = 0; k < pairs.length; k++) {
        const p = pairs[k];
        promises.push(i.guild.members.fetch(p.a).catch(() => null));
        promises.push(i.guild.members.fetch(p.b).catch(() => null));
      }
      const fetchedMembers = await Promise.all(promises);
      const memberMap = new Map();
      for (const m of fetchedMembers) if (m) memberMap.set(m.id, m);
      for (let k = 0; k < pairs.length; k++) {
        const p = pairs[k];
        const m1 = memberMap.get(p.a);
        const m2 = memberMap.get(p.b);
        const name1 = m1 ? m1.user.username : p.a;
        const name2 = m2 ? m2.user.username : p.b;
        const note = p.notes.join('; ');
        csvContent += `${k+1},${p.a},"${name1}",${p.b},"${name2}",${p.score},"${note}"\n`;
        if (k < 10) preview += `\`${k+1}\` <@${p.a}> ❤️ <@${p.b}> (\`${p.score}\`) [${p.notes.join(', ')}]\n`;
      }
      const file = new AttachmentBuilder(Buffer.from(csvContent, 'utf-8'), { name: `cupid-preview-${batchId}.csv` });
      let replyOptions = { content: preview, files: [file] };
      if (pairs.length > 10) replyOptions.content += `\n...等等。完整的清單已附在 CSV 檔案中。`;
      replyOptions.content += `\n\n使用 \`/cupid_approve batch_id:${batchId}\` 來批准。`;
      replyOptions.content += `\n\n使用 \`/pair batch_id:${batchId} pair_id:[序號]\` 來建立特定配對。`;
      await i.editReply(replyOptions);
      return;
    }

    if (name === 'cupid_approve') {
      if (!i.member.permissions.has(PermissionFlagsBits.Administrator)) return i.reply({ content: '沒有權限。', ephemeral: true });
      await i.deferReply();
      const batchId = i.options.getString('batch_id', true);
      const indicesRaw = i.options.getString('indices') || '';
      const batch = store.cupidBatches[batchId];
      if (!batch) return i.editReply('❌ 無效的批次 ID。');
      delete store.cupidBatches[batchId];
      let pairsToMatch = batch.pairs;
      if (indicesRaw) {
        const indices = new Set(indicesRaw.split(',').map(x => Number(x.trim())).filter(x => x > 0 && x <= batch.pairs.length));
        pairsToMatch = pairsToMatch.filter((_, idx) => indices.has(idx + 1));
      }
      if (!pairsToMatch.length) return i.editReply('❌ 沒有要批准的配對。');
      let matchedCount = 0;
      for (const p of pairsToMatch) {
        const [u1, u2] = await Promise.all([
          i.guild.members.fetch(p.a).catch(() => null),
          i.guild.members.fetch(p.b).catch(() => null)
        ]);
        if (u1 && u2) {
          try {
            const existing = await findExistingPairRoom(i.guild, u1.id, u2.id);
            if (existing) continue;
            await createPrivateRoom(i.guild, u1, u2);
            rememberPair(u1.id, u2.id);
            await incSuccess([u1.id, u2.id]);
            matchedCount++;
          } catch (e) {
            console.error(`Error creating room for ${u1?.id}-${u2?.id}:`, e);
          }
        }
      }
      if (matchedCount > 0) await announceNewMatch(i.guild);
      await i.editReply(`✅ 已批准並建立了 ${matchedCount} 個配對房。`);
      return;
    }

    if (name === 'pair') {
      if (!i.member.permissions.has(PermissionFlagsBits.Administrator)) return i.reply({ content: '沒有權限。', ephemeral: true });
      await i.deferReply();
      const batchId = i.options.getString('batch_id', true);
      const pairIndex = i.options.getInteger('pair_id', true);
      const batch = store.cupidBatches[batchId];
      if (!batch) return i.editReply('❌ 無效的批次 ID。');
      if (pairIndex <= 0 || pairIndex > batch.pairs.length) return i.editReply(`❌ 無效的配對序號。請提供一個介乎 1 到 ${batch.pairs.length} 之間的數字。`);
      const p = batch.pairs[pairIndex - 1];
      const [u1, u2] = await Promise.all([
        i.guild.members.fetch(p.a).catch(() => null),
        i.guild.members.fetch(p.b).catch(() => null)
      ]);
      if (!u1 || !u2) return i.editReply('❌ 無法找到配對中的一位或兩位成員。');
      try {
        const existing = await findExistingPairRoom(i.guild, u1.id, u2.id);
        if (existing) return i.editReply(`你哋已有配對房：${existing}`);
        await createPrivateRoom(i.guild, u1, u2);
        rememberPair(u1.id, u2.id);
        await incSuccess([u1.id, u2.id]);
        await announceNewMatch(i.guild);
        await i.editReply(`✅ 已為 <@${u1.id}> 和 <@${u2.id}> 建立了配對房。`);
      } catch (e) {
        console.error(`Error creating room for ${u1?.id}-${u2?.id}:`, e);
        await i.editReply('❌ 建立配對房時發生錯誤。');
      }
      return;
    }

    if (name === 'sync_profiles') {
      if (!i.member.permissions.has(PermissionFlagsBits.Administrator)) return i.reply({ content: '沒有權限。', ephemeral: true });
      await i.deferReply();
      const { updated, skipped, eligible } = await syncProfilesFromGoogleSheet(i.guild);
      await i.editReply(`✅ 已同步資料：\n- 更新 ${updated} 位成員資料\n- 跳過 ${skipped} 行\n- 合資格配對的成員共 ${eligible} 位。`);
      return;
    }

    if (name === 'check_profiles') {
      if (!i.member.permissions.has(PermissionFlagsBits.Administrator)) return i.reply({ content: '沒有權限。', ephemeral: true });
      const user = i.options.getUser('user', true);
      const profile = store.profiles[user.id];
      const activity = store.activity[user.id];
      const embed = new EmbedBuilder().setTitle(`成員資料：${user.username}`).setDescription(`Discord ID: ${user.id}`).setColor('Green');
      if (!profile) {
        embed.addFields({ name: '❌ 未找到資料', value: 'Google Sheet 中沒有該成員的資料。請檢查 `register` 表格。' });
      } else {
        const targetSexValue = (profile.targetSex && profile.targetSex.length > 0) ? profile.targetSex.join(', ') : 'N/A (未指定或不限)';
        embed.addFields(
          { name: '✅ 參與配對', value: profile.consent ? '是' : '否', inline: true },
          { name: '✨ 會員身分', value: profile.memberU ? '是' : '否', inline: true },
          { name: '🗓️ 活躍度', value: activity ? `最近一次活躍：${new Date(activity).toLocaleString()}` : '無紀錄', inline: false },
          { name: '性別', value: profile.sex || 'N/A', inline: true },
          { name: '年齡', value: profile.age || 'N/A', inline: true },
          { name: '目標性別', value: targetSexValue, inline: false },
        );
      }
      await i.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    if (name === 'health') {
      if (!i.member.permissions.has(PermissionFlagsBits.Administrator)) return i.reply({ content: '沒有權限。', ephemeral: true });
      const memoryUsage = process.memoryUsage();
      const info = [
        `**✅ Bot 健康檢查**`,
        `・延遲：${client.ws.ping}ms`,
        `・記憶體用量：${(memoryUsage.rss / 1024 / 1024).toFixed(2)} MB`,
        `・伺服器：${client.guilds.cache.size}`,
        `・成員：${client.guilds.cache.get(GUILD_ID)?.memberCount || 'N/A'}`,
        `・配對總數：${store.totalMatches || 0}`,
        `・iTalk 卡片：${ITALK_QUESTIONS.length} 張`,
      ].join('\n');
      await i.reply({ content: info, ephemeral: true });
      return;
    }
  } catch (err) {
    console.error(err);
    try {
      if (i.isRepliable()) await i.reply({ content: `發生錯誤：${err.message}`, ephemeral: true });
    } catch {}
  }
});

// ====== Robustness / Auto-reconnect & crash-guard ======
// Discord will auto-reconnect on transient issues; we just log.
// If the session becomes invalid (e.g., token rotated), exit so PM2 restarts.
client.on('error', (e) => console.error('Client error:', e));
client.on('shardError', (e, id) => console.error(`Shard ${id} error:`, e));
client.on('shardDisconnect', (event, id) => console.warn(`Shard ${id} disconnected:`, event?.code || event));
client.on('shardReconnecting', (id) => console.warn(`Shard ${id} reconnecting...`));
client.on('invalidated', () => {
  console.error('⚠️ Session invalidated. Exiting for PM2 to restart.');
  process.exit(1);
});

// Crash-guards so a random exception doesn’t kill the bot
process.on('unhandledRejection', (reason) => console.error('UnhandledRejection:', reason));
process.on('uncaughtException', (err) => console.error('UncaughtException:', err));

// =============== START ===============
client.login(TOKEN);

// ================= iMatch helpers and modules (after listeners to reduce clutter) =================

async function ensurePrivateCategory(g) {
  const c = g.channels.cache.get(PRIVATE_CATEGORY_ID) || await g.channels.fetch(PRIVATE_CATEGORY_ID).catch(() => null);
  if (c && c.type === ChannelType.GuildCategory) return c;
  throw new Error('Private category missing');
}
async function ensureGroupCategory(g) {
  const c = g.channels.cache.get(GROUP_CATEGORY_ID) || await g.channels.fetch(GROUP_CATEGORY_ID).catch(() => null);
  if (c && c.type === ChannelType.GuildCategory) return c;
  return g.channels.create({
    name: '👥 iMatch – Groups',
    type: ChannelType.GuildCategory,
    permissionOverwrites: [{ id: g.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }]
  });
}
async function getStaffChannel(g) {
  const c = g.channels.cache.get(STAFF_CHANNEL_ID) || await g.channels.fetch(STAFF_CHANNEL_ID).catch(() => null);
  return c?.isTextBased?.() ? c : (g.systemChannel || null);
}
async function getAnnounceChannel(g) {
  const c = g.channels.cache.get(ANNOUNCE_CHANNEL_ID) || await g.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(() => null);
  return c?.isTextBased?.() ? c : null;
}
async function findExistingPairRoom(guild, a, b) {
  const k = pairKey(a, b);
  return guild.channels.cache.find(
    c => c.type === ChannelType.GuildText && (c.topic || '').includes(`PAIR:${k}`)
  ) || null;
}
function parseCreatedAtFromTopic(topic = '') {
  const m = topic.match(/Created:([0-9TZ:\.\-\+]+)/i);
  const t = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(t) ? t : null;
}
const CLOSE_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
async function sweepExpiredRooms(guild) {
  const now = Date.now(), ttl = Math.max(1, MATCH_LIFETIME_HOURS) * 3600 * 1000;
  const ids = [PRIVATE_CATEGORY_ID, GROUP_CATEGORY_ID];
  for (const catId of ids) {
    const chans = guild.channels.cache.filter(c => c.type === ChannelType.GuildText && c.parentId === catId);
    for (const ch of chans.values()) {
      if (ch.id === STAFF_CHANNEL_ID || ch.id === REQUEST_CHANNEL_ID) continue;
      let createdAtMs = parseCreatedAtFromTopic(ch.topic || '') ?? ch.createdTimestamp;
      if (!createdAtMs) continue;
      if (now - createdAtMs >= ttl) {
        try { await ch.delete('iMatch auto-sweep (expired)'); } catch {}
      }
    }
  }
}
async function nextRoomNumber(guild, categoryId, prefix = '💌 private-room-') {
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc}(\\d+)$`);
  const siblings = guild.channels.cache.filter(ch => ch.parentId === categoryId && ch.type === ChannelType.GuildText);
  const used = new Set();
  for (const ch of siblings.values()) {
    const m = ch.name.match(re);
    if (m) used.add(Number(m[1]));
  }
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

// iTalk loader
let ITALK_QUESTIONS = [];
async function loadItalkFromGoogleSheet() {
  if (!GS_ENABLED || !sheets) return false;
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: ITALK_GSHEET_ID, range: ITALK_GSHEET_RANGE });
    const rows = res.data.values || [];
    ITALK_QUESTIONS = rows.map(r => String(r?.[0] ?? '').trim()).filter(Boolean);
    console.log(`[iTalk] Loaded: ${ITALK_QUESTIONS.length} cards`);
    return ITALK_QUESTIONS.length > 0;
  } catch (e) {
    console.warn('[iTalk]', e.message);
    return false;
  }
}
const pickItalkCard = () => !ITALK_QUESTIONS.length ? 'Card_ID' : ITALK_QUESTIONS[Math.floor(Math.random() * ITALK_QUESTIONS.length)];

// MBTI cache
const MBTI_TYPES = ['ENFJ', 'ENFP', 'ENTJ', 'ENTP', 'ESFJ', 'ESFP', 'ESTJ', 'ESTP', 'INFJ', 'INFP', 'INTJ', 'INTP', 'ISFJ', 'ISFP', 'ISTJ', 'ISTP'];
const MBTI_SET = new Set(MBTI_TYPES);
let MBTI_TABLE = null;
const normalizeType = s => {
  const x = (s || '').toUpperCase().trim();
  return MBTI_SET.has(x) ? x : '';
};
async function loadMbtiCacheJSON() {
  try {
    if (!fssync.existsSync(MBTI_MATRIX_PATH)) return false;
    const raw = await fs.readFile(MBTI_MATRIX_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!data?.table) return false;
    MBTI_TABLE = data.table;
    console.log(`[Cupid] MBTI loaded from JSON cache: ${MBTI_MATRIX_PATH}`);
    return true;
  } catch (e) {
    console.warn('[Cupid] MBTI cache load failed:', e.message);
    return false;
  }
}
function mbtiScoreFromCache15(a, b) {
  if (!MBTI_TABLE) return { available: false, score15: 0, raw100: 0, note: 'MBTI table not loaded' };
  const A = store.profiles[a] || {}, B = store.profiles[b] || {};
  const ta = normalizeType(A.mbti), tb = normalizeType(B.mbti);
  if (!ta || !tb) return { available: false, score15: 0, raw100: 0, note: 'MBTI missing' };
  const raw = MBTI_TABLE[ta]?.[tb];
  if (raw == null) return { available: false, score15: 0, raw100: 0, note: 'MBTI cell missing' };
  return { available: true, score15: +(raw / 100 * 15).toFixed(2), raw100: raw, note: `MBTI ${ta}-${tb}: ${raw}/100 (+${+(raw / 100 * 15).toFixed(2)}/15)` };
}

// Profiles and votes from Sheets
const MEMBER_COL_U_INDEX = 20;
const norm = s => String(s ?? '').trim();
const split = s => norm(s).split(/[，,;\/]/).map(x => x.trim()).filter(Boolean);
async function resolveDiscordIdFromSheetName(guild, raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d{15,}$/.test(s)) return s;
  const m = s.match(/^<@!?(\d{15,})>$/);
  if (m) return m[1];
  if (s.includes('#')) {
    const t = s.toLowerCase();
    const hit = guild.members.cache.find(mm => mm.user.tag.toLowerCase() === t);
    if (hit) return hit.id;
  }
  const byUser = guild.members.cache.filter(mm => (mm.user.username || '').toLowerCase() === s.toLowerCase());
  if (byUser.size === 1) return byUser.first().id;
  const byNick = guild.members.cache.filter(mm => (mm.nickname || '').toLowerCase() === s.toLowerCase());
  if (byNick.size === 1) return byNick.first().id;
  return null;
}
function findCol(header, candidates) {
  for (const c of candidates) {
    const i = header.findIndex(h => h === c.toLowerCase());
    if (i >= 0) return i;
  }
  for (const c of candidates) {
    const i = header.findIndex(h => h.includes(c.toLowerCase()));
    if (i >= 0) return i;
  }
  return -1;
}
async function syncProfilesFromGoogleSheet(guild) {
  if (!GS_ENABLED || !sheets) throw new Error('missing Google credentials');
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: REG_GSHEET_ID, range: REG_GSHEET_RANGE });
  const rows = res.data.values || [];
  if (!rows.length) return { updated: 0, skipped: 0, eligible: 0 };
  const header = rows[0].map(h => norm(h).toLowerCase());
  const col = {
    discordId: findCol(header, ['discord id', 'discord_id', 'user id', 'uid']),
    discordName: findCol(header, ['discord username', 'discord', 'discord 名', 'discord用戶名']),
    age: findCol(header, ['幾多歲？', '年齡', 'age']),
    sex: findCol(header, ['性別', 'sex']),
    targetSex: findCol(header, ['你希望認識哪個性別嘅朋友 ?', '目標性別', 'target sex']),
    ageMin: findCol(header, ['目標年齡最小', 'target age min']),
    ageMax: findCol(header, ['目標年齡最大', 'target age max']),
    hobbies: findCol(header, ['Hobby Categorization', '你的興趣', '興趣', 'hobbies']),
    mbti: findCol(header, ['mbti']),
    consent: findCol(header, ['參與配對', 'consent', '同意配對']),
    isMember: findCol(header, ['member', '會員']),
  };
  let updated = 0, skipped = 0, eligible = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] || [];
    let discordId = col.discordId >= 0 ? norm(row[col.discordId]) : '';
    if (!/^\d{15,}$/.test(discordId)) {
      const nameCell = col.discordName >= 0 ? row[col.discordName] : '';
      discordId = await resolveDiscordIdFromSheetName(guild, nameCell);
    }
    if (!discordId) { skipped++; continue; }
    const prof = store.profiles[discordId] || {};
    if (col.sex >= 0) prof.sex = norm(row[col.sex]);
    if (col.targetSex >= 0) {
      const rawTargetSex = row[col.targetSex];
      prof.targetSex = split(rawTargetSex);
    }
    if (col.age >= 0) prof.age = row[col.age] || 'N/A';
    if (col.ageMin >= 0) prof.ageMin = Number(row[col.ageMin]);
    if (col.ageMax >= 0) prof.ageMax = Number(row[col.ageMax]);
    if (col.hobbies >= 0) prof.hobbies = split(row[col.hobbies]);
    if (col.mbti >= 0) {
      const raw = norm(row[col.mbti]).toUpperCase();
      const mb = (raw.match(/[EI][NS][FT][JP]/) || [])[0] || '';
      prof.mbti = mb;
    }
    if (col.consent >= 0) {
      const c = norm(row[col.consent]).toLowerCase();
      prof.consent = ['y', 'yes', 'true', '1', '同意', '會', '係'].some(t => c.includes(t));
    }
    if (col.isMember >= 0) {
      const m = norm(row[col.isMember]).toLowerCase();
      prof.isMember = ['y', 'yes', 'true', '1', '係', '是', '會員'].some(t => m.includes(t));
    }
    const memberU = row[MEMBER_COL_U_INDEX];
    prof.memberU = String(memberU ?? '').trim().toLowerCase().startsWith('y');
    store.profiles[discordId] = prof;
    updated++;
    if (prof.memberU && prof.consent !== false) eligible++;
  }
  await saveStore();
  return { updated, skipped, eligible };
}

// Votes
let VOTES = {};
async function loadVotesFromSheet() {
  VOTES = {};
  if (!GS_ENABLED || !sheets) return false;
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: VOTE_GSHEET_ID, range: VOTE_GSHEET_RANGE });
    const rows = res.data.values || [];
    if (rows.length < 2) { console.log('[Votes] empty'); return true; }
    const head = rows[0].map(x => String(x).trim().toLowerCase());
    const colUser = head.findIndex(x => x.includes('user'));
    const colVote = head.findIndex(x => x.includes('vote'));
    const colTime = head.findIndex(x => x.includes('time'));
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const uid = String(row[colUser] || '').trim();
      const vid = String(row[colVote] || '').trim();
      const ts = Date.parse(row[colTime] || '') || i;
      if (!uid || !vid) continue;
      VOTES[uid] ??= [];
      VOTES[uid].push({ id: vid, ts });
    }
    for (const k of Object.keys(VOTES)) VOTES[k].sort((a, b) => b.ts - a.ts);
    console.log(`[Votes] OK { users: ${Object.keys(VOTES).length}, votes: ${Object.values(VOTES).reduce((a, x) => a + x.length, 0)} }`);
    return true;
  } catch (e) {
    console.warn('[Votes]', e.message);
    return false;
  }
}
function everydayVote15(a, b) {
  const A = VOTES[a] || [], B = VOTES[b] || [];
  if (!A.length || !B.length) return { available: false, score: 0, note: '投票不足' };
  const a50 = A.slice(0, 50), b50 = B.slice(0, 50);
  const mapB = new Map(b50.map((x, i) => [x.id, i]));
  const commons = [];
  for (let i = 0; i < a50.length; i++) {
    const id = a50[i].id;
    if (mapB.has(id)) commons.push({ aIdx: i, bIdx: mapB.get(id) });
  }
  if (commons.length < 5) return { available: false, score: 0, note: '投票不足' };
  const maxIndex = 49;
  const avg = commons.reduce((s, c) => s + ((c.aIdx + c.bIdx) / (2 * maxIndex)), 0) / commons.length;
  const score = +((1 - avg) * 15).toFixed(2);
  return { available: true, score, note: `${commons.length}` };
}

// Cupid
const ANY_SET = new Set(['無特別', '不限', 'any', '全部', '任意', '無偏好', 'n/a']);
const sexTargetCompatible = (a, b) => {
  const A = store.profiles[a] || {}, B = store.profiles[b] || {};
  const aSex = (A.sex || '').toLowerCase(), bSex = (B.sex || '').toLowerCase();
  const targA = (A.targetSex || []).map(s => String(s).toLowerCase());
  const targB = (B.targetSex || []).map(s => String(s).toLowerCase());
  const aOk = (targA.length > 0 && (ANY_SET.has(targA[0]) || targA.includes(bSex)));
  const bOk = (targB.length > 0 && (ANY_SET.has(targB[0]) || targB.includes(aSex)));
  return aOk && bOk;
};
const ageGapOK = (a, b) => {
  const A = store.profiles[a] || {}, B = store.profiles[b] || {};
  const ageA = Number(A.age), ageB = Number(B.age);
  if (!isFinite(ageA) || !isFinite(ageB)) return false;
  return Math.abs(ageA - ageB) <= 6;
};
const activity20 = (a, b) => {
  const A = (store.profiles[a]?.hobbies || []).map(s => String(s).toLowerCase());
  const B = (store.profiles[b]?.hobbies || []).map(s => String(s).toLowerCase());
  const sa = new Set(A), sb = new Set(B);
  if (!sa.size && !sb.size) return { available: false, score: 0, note: '興趣不足' };
  const u = new Set([...sa, ...sb]);
  let inter = 0; for (const x of sa) if (sb.has(x)) inter++;
  const j = u.size ? inter / u.size : 0;
  return { available: true, score: +(j * 20).toFixed(2), note: `${(j * 100).toFixed(0)}%` };
};
const age35 = (a, b) => {
  const A = store.profiles[a] || {}, B = store.profiles[b] || {};
  const ageA = Number(A.age), ageB = Number(B.age);
  if (!isFinite(ageA) || !isFinite(ageB)) return { available: false, score: 0, note: '年齡缺' };
  const gap = Math.abs(ageA - ageB);
  const ratio = Math.max(0, 1 - gap / 6);
  return { available: true, score: +(ratio * 35).toFixed(2), note: `${gap}` };
};
function computeCupidScore(a, b) {
  if (!sexTargetCompatible(a, b)) return { ok: false, score: 0, notes: ['目標不合'] };
  if (!ageGapOK(a, b)) return { ok: false, score: 0, notes: ['年齡差>6'] };
  const m = mbtiScoreFromCache15(a, b);
  const g = age35(a, b);
  const h = activity20(a, b);
  const v = everydayVote15(a, b);
  const parts = [m, g, h, v];
  const base = [15, 35, 20, 15];
  let sumBase = 0, sumScore = 0;
  for (let i = 0; i < 4; i++) {
    if (parts[i].available !== false) {
      sumBase += base[i];
      sumScore += (parts[i].score ?? parts[i].score15 ?? 0) * base[i];
    }
  }
  if (!sumBase) return { ok: false, score: 0, notes: ['資料不足'] };
  const score = +(sumScore / sumBase).toFixed(1);
  const notes = [];
  if (m.available) notes.push(`MBTI ${m.raw100}/100 (+${m.score15}/15)`);
  if (g.available) notes.push(`年齡差 ${g.note}`);
  if (h.available) notes.push(`興趣 ${h.note}`);
  if (v.available) notes.push(`投票 ${v.note}`);
  return { ok: true, score, notes };
}
const profileEligibleForCupid = uid => !!(store.profiles[uid]?.memberU && store.profiles[uid]?.consent !== false);
async function computeCupidPairs(guild) {
  const members = [...guild.members.cache.values()].filter(m => !m.user.bot);
  const cand = [];
  for (const m of members) {
    if (!profileEligibleForCupid(m.id)) continue;
    if (!isActiveIn7Days(m.id)) { console.log(`User ${m.id} skipped for Cupid preview due to inactivity.`); continue; }
    cand.push(m.id);
  }
  const isAny = uid => ((store.profiles[uid]?.targetSex || [])[0] || '').includes('無特別');
  let pairs = [];
  for (let i = 0; i < cand.length; i++) {
    for (let j = i + 1; j < cand.length; j++) {
      const a = cand[i], b = cand[j];
      if (everPaired(a, b)) continue;
      const S = computeCupidScore(a, b);
      if (!S.ok) continue;
      pairs.push({ a, b, score: S.score, notes: S.notes, anyA: isAny(a), anyB: isAny(b) });
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  const chosen = [], usedCount = Object.fromEntries(cand.map(id => [id, 0]));
  const used = new Set();
  const tryPick = p => {
    if (usedCount[p.a] >= 2 || usedCount[p.b] >= 2) return false;
    if (used.has(p.a) && used.has(p.b)) return false;
    chosen.push(p);
    usedCount[p.a]++;
    usedCount[p.b]++;
    used.add(p.a); used.add(p.b);
    return true;
  };
  for (const p of pairs) { if (!p.anyA && !p.anyB) tryPick(p); }
  for (const id of cand) {
    if (usedCount[id] === 0) {
      const p = pairs.find(x => (x.a === id || x.b === id) && usedCount[x.a] < 2 && usedCount[x.b] < 2);
      if (p) tryPick(p);
    }
  }
  for (const p of pairs) tryPick(p);
  return chosen;
}

const userMention = u => `<@${u.id||u}>`;
function chooseIntroStarter(aUser, bUser, guild) {
  const A = guild.members.cache.get(aUser), B = guild.members.cache.get(bUser);
  const aMale = A?.roles.cache.has(ROLE_MALE_ID), bMale = B?.roles.cache.has(ROLE_MALE_ID);
  if (aMale && !bMale) return A?.user || { id: aUser };
  if (bMale && !aMale) return B?.user || { id: bUser };
  return A?.user || { id: aUser };
}
function buildOpener(aUser, bUser, guild) {
  const starter = chooseIntroStarter(aUser.id || aUser, bUser.id || bUser, guild);
  const atStarter = userMention(starter);
  const firstCard = pickItalkCard();
  const firstMessage = [
    `🗣️ 你們的配對房已建立！`,
    `⏳ 房間會在 **${MATCH_LIFETIME_HOURS} 小時** 後自動關閉（可用 \`/extend\` 延長 **${MATCH_LIFETIME_HOURS} 小時**，每房只可一次）。`,
    `🙋 請由 ${atStarter} 先作一個簡單自我介紹～`,
    ``,
    `💡 想要新問題？用 \`/italkcard\` 抽一張！`,
  ].join('\n');
  const secondMessage = `🃏 第一張 iTalk Card：${firstCard}`;
  return { firstMessage, secondMessage };
}
function getItalkLimits(member) {
  let lim = { ...DEFAULT_ITALK_LIMITS };
  for (const [rid, cfg] of Object.entries(ROLE_ITALK_LIMITS)) {
    if (member.roles.cache.has(rid)) lim.maxPerDay = Math.min(lim.maxPerDay, cfg.maxPerDay);
  }
  return lim;
}
function canUseItalk(channelId, userId, member) {
  const limits = getItalkLimits(member);
  if (limits.maxPerDay === 0) return { ok: false, msg: '你沒有權限使用 iTalk 卡片。', used: 0, left: 0, limits };
  store.roomUsage ??= {};
  store.roomUsage[channelId] ??= { italkUsage: {}, extended: false };
  const dailyUsage = store.roomUsage[channelId].italkUsage[userId] ?? { lastUsedDate: null, count: 0 };
  const today = new Date().toISOString().split('T')[0];
  if (dailyUsage.lastUsedDate !== today) { dailyUsage.count = 0; dailyUsage.lastUsedDate = today; }
  const ok = dailyUsage.count < limits.maxPerDay;
  return { ok, used: dailyUsage.count, left: limits.maxPerDay - dailyUsage.count, limits };
}
async function markItalkUsed(channelId, userId) {
  store.roomUsage ??= {};
  store.roomUsage[channelId] ??= { italkUsage: {}, extended: false };
  const dailyUsage = store.roomUsage[channelId].italkUsage[userId] ?? { lastUsedDate: null, count: 0 };
  const today = new Date().toISOString().split('T')[0];
  if (dailyUsage.lastUsedDate !== today) { dailyUsage.count = 0; dailyUsage.lastUsedDate = today; }
  dailyUsage.count++;
  store.roomUsage[channelId].italkUsage[userId] = dailyUsage;
  return saveStore();
}
function markExtended(channelId) {
  store.roomUsage ??= {};
  store.roomUsage[channelId] ??= { italkUsage: {}, extended: false };
  if (store.roomUsage[channelId].extended) return false;
  store.roomUsage[channelId].extended = true;
  saveStore();
  return true;
}
async function createPrivateRoom(guild, aUser, bUser) {
  const cat = await ensurePrivateCategory(guild);
  const n = await nextRoomNumber(guild, cat.id, '💌 private-room-');
  const name = `💌 private-room-${n}`;
  const ids = [aUser.id, bUser.id].sort();
  const ch = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: cat.id,
    permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: aUser.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: bUser.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
      ...(ADMIN_ROLE_ID ? [{ id: ADMIN_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] }] : [])
    ],
    topic: `PAIR:${ids.join('-')}｜Created:${new Date().toISOString()}`
  });
  const opener = buildOpener(aUser, bUser, guild);
  await ch.send(opener.firstMessage);
  await ch.send(opener.secondMessage);
  const ttl = Math.max(1, MATCH_LIFETIME_HOURS) * 3600 * 1000;
  const t24 = ttl - 24 * 3600 * 1000; if (t24 > 5000) setTimeout(() => ch.send('⏰ 提醒：房間將於 **24 小時** 後關閉。').catch(() => {}), t24);
  const t3 = ttl - 3 * 3600 * 1000; if (t3 > 5000) setTimeout(() => ch.send('⏰ 提醒：房間將於 **3 小時** 後關閉。').catch(() => {}), t3);
  setTimeout(async () => { try { await ch.delete('iMatch auto-close match room'); } catch {} }, ttl);
  return ch;
}
async function createGroupRoom(guild, users, topicText) {
  const cat = await ensureGroupCategory(guild);
  const n = await nextRoomNumber(guild, cat.id, '👩‍👩‍👦‍👦group-chat-');
  const name = `👩‍👩‍👦‍👦group-chat-${n}`;
  const ids = users.map(u => u.id).sort();
  const ch = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: cat.id,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
      ...ids.map(uid => ({ id: uid, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
      ...(ADMIN_ROLE_ID ? [{ id: ADMIN_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] }] : [])
    ],
    topic: `GROUP:${ids.join('-')}｜Created:${new Date().toISOString()}${topicText?`｜Topic:${topicText}`:''}`
  });
  const ttl = Math.max(1, MATCH_LIFETIME_HOURS) * 3600 * 1000;
  const t24 = ttl - 24 * 3600 * 1000; if (t24 > 5000) setTimeout(() => ch.send('⏰ 提醒：房間將於 **24 小時** 後關閉。').catch(() => {}), t24);
  const t3 = ttl - 3 * 3600 * 1000; if (t3 > 5000) setTimeout(() => ch.send('⏰ 提醒：房間將於 **3 小時** 後關閉。').catch(() => {}), t3);
  setTimeout(async () => { try { await ch.delete('iMatch auto-close group room'); } catch {} }, ttl);
  return ch;
}
async function announceNewMatch(guild) {
  const ch = await getAnnounceChannel(guild); if (!ch) return;
  await ch.send(`🎉 有新配對成功！目前累積 **${store.totalMatches || 0}** 個配對。`).catch(() => {});
}
const consentRow = (rid) => ({ type: 1, components: [
  { type: 2, style: 3, label: '✅ 接受', custom_id: `accept_${rid}` },
  { type: 2, style: 4, label: '❌ 拒絕', custom_id: `decline_${rid}` }
]});

// Button interactions for match_request consent
client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isButton()) return;
    if (!(interaction.customId.startsWith('accept_') || interaction.customId.startsWith('decline_'))) return;
    const reqKey = interaction.customId.split('_')[1];
    const [requesterId, targetId] = reqKey.split('-');
    if (interaction.user.id !== targetId) return interaction.reply({ content: '這個按鈕不是給你的。', ephemeral: true });
    const guild = interaction.guild;
    const requester = await guild.members.fetch(requesterId).catch(() => null);
    if (!requester) return interaction.reply({ content: '配對請求發起人已不在伺服器。', ephemeral: true });
    if (!isRequestActive(requesterId, targetId)) return interaction.reply({ content: '配對請求已過期。', ephemeral: true });
    if (interaction.customId.startsWith('decline_')) {
      await clearPendingRequest(requesterId, targetId);
      await interaction.update({ content: '❌ 你已拒絕了配對請求。', components: [] });
      await requester.send(`❌ <@${targetId}> 拒絕了你的配對請求。`).catch(() => {});
      return;
    }
    // Accept
    await clearPendingRequest(requesterId, targetId);
    await interaction.update({ content: '✅ 你已接受了配對請求！', components: [] });
    const exist = await findExistingPairRoom(guild, requesterId, targetId);
    if (exist) return interaction.followUp({ content: `你哋已有配對房：${exist}`, ephemeral: true });
    const ch = await createPrivateRoom(guild, requester, interaction.user);
    rememberPair(requesterId, targetId);
    await incSuccess([requesterId, targetId]).catch(() => {});
    await announceNewMatch(guild).catch(() => {});
    await requester.send(`🎉 <@${targetId}> 接受了你的配對請求！你們的房間已建立：${ch}`).catch(() => {});
  } catch (e) { console.error(e); }
});

