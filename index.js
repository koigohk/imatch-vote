'use strict';
require('dotenv').config();

const {
  Client, GatewayIntentBits, Events,
  REST, Routes, SlashCommandBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder
} = require('discord.js');
const dayjs = require('dayjs');

// =============== ENV =================
const TOKEN        = (process.env.TOKEN || '').trim();
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
if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('❌ Missing TOKEN / CLIENT_ID / GUILD_ID in .env');
}
if (GS_ENABLED && (!SPREADSHEET_ID || !GS_EMAIL || !GS_PRIVATE)) {
  console.error('❌ Missing Google Sheets credentials/ids in .env');
}

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
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function registerCommands() {
  const commands = [
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

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
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
