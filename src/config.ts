/**
 * 配置段与设置页。
 *
 * 每一个字段都必须有读取点（见 world.ts 里的 this.cfg.xxx）；只声明不接线，
 * 使用者改了没效果而且不报错——这是这个框架最容易骗人的一处。
 *
 * 设置页按「会改的东西」分组，不按代码结构分组：说话节奏 / 读哪边 / 特殊时刻 / 记录与权限。
 * 顺序就是看见的顺序，最常动的放最前。
 */
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { WorldSection } from 'cortico/world.ts';
import type { PlayerPref } from './players.ts';
import { suggestedMemoryDir } from './storage.ts';

export const MUSIC_ID = 'music';

/** 开口频率。把"别太吵"做成代码里的规则，而不是指望模型自律。 */
export type Chatinness = 'quiet' | 'normal';

export interface MusicConfigSection extends WorldSection {
  /** 她多爱接话。 */
  chatiness: Chatinness;
  /** 同时开着两个播放器时听谁的。 */
  player: PlayerPref;
  /** 采样间隔（毫秒）。改完要重启扩展实例。 */
  intervalMs: number;
  /** 额外认作播放器的 AUMID 片段，逗号分隔。 */
  extraPlayers: string;
  /** 深夜起点小时（0–23），窗口到 05:00。 */
  nightFrom: number;
  /** 连续听多久算"久听"。 */
  longMinutes: number;
  /** 听歌记录保留多少天。 */
  keepDays: number;
  /**
   * 记忆存到哪个文件夹。留空＝跟着这台机器。
   *
   * 填一个两边都看得见的目录（OneDrive、NAS、移动硬盘），公司和家里就是同一份记忆。
   * 只影响**记忆**类数据；当前播放状态和歌词缓存永远在本机，见 storage.ts。
   */
  memoryDir: string;
  /** 允许她代为暂停/切歌。 */
  controlAllowed: boolean;
  /** 一首歌切成多长一段（秒）。每段结束推一条事件，让她就这一段说一句。0 = 不评论。 */
  segmentEverySec: number;
  /** 每首最多说几段。短歌靠它压次数，长曲靠它把段长拉开。 */
  maxSegmentsPerTrack: number;
  /** 允许她自己搜歌、挑歌。关了就只有看着的份。 */
  selfPick: boolean;
  /** 她上哪找歌。auto = 两个库都搜。 */
  pickSource: 'auto' | 'qq' | 'netease';
  /** 她什么时候可以主动挑：ask = 你问或话题合适时；idle = 静下来没歌时自己挑一首。 */
  pickWhen: 'ask' | 'idle';
  /**
   * 接力点歌。
   *
   * 打开后：她递给你的那首快放完时（剩约 35 秒），她会把下一首也挑好递过来，
   * 最多连 6 首。**播放那一下仍然是你点** —— 两个客户端都不接受外部点播，
   * 唯一能替她按的是「电脑操作」（桌宠那边的 CUA），而那要先问她、她再用鼠标点。
   */
  relayPick: boolean;
  /**
   * 允许她改自己的口味档案（记忆目录里的 `music-soul.md`）。
   *
   * 关掉只是不让她写，**读一直照旧** —— 她仍然知道自己爱听什么。
   * 想亲手写这份文件的人把这个关掉就行，文件本身可以直接编辑。
   */
  soulWritable: boolean;
  /**
   * 跟着真实音频的拍子动（系统回环采集）。
   *
   * 打开后：她不再按写死的频率晃，而是按这首歌实际的 BPM 晃。采集在本机做——
   * 把声卡「正在放的东西」复制一份算能量，**不录音、不存波形、不联网**。
   * 代价它听得到系统里所有声音（会议、提示音），所以必须能关。
   */
  audioReactive: boolean;
  /**
   * 深听听哪条路。
   *
   * cloud = 把最近十几秒的临时 WAV 发给一个支持音频输入的模型（要 key，快，不占空间）；
   * local = 本机 Python 分轨（不联网，但要先下约 500MB）；
   * off = 只留能量层，没有调性/和弦/旋律。
   */
  hearingMode: 'cloud' | 'local' | 'off';
  /** 云端密钥。明文存在扩展配置里，只在本机读，不会写进记忆目录。 */
  hearingCloudKey: string;
  /** 云端地址，到 /v1 为止。换服务商就改这一行。 */
  hearingCloudBase: string;
  /** 云端模型名。必须支持音频输入。 */
  hearingCloudModel: string;
  /**
   * 自动累积：每隔多少秒偷偷深听一段，攒成整首的档案。
   *
   * **0 = 只在被问到时听。** 云端模式每段都是一次计费调用，默认不能悄悄花他的钱。
   */
  hearingEverySec: number;
  /**
   * 唱词转写：走本地深听时，顺手把已分离的人声轨送进 ASR，听出「在唱什么」。
   *
   * 这不是歌词——歌词是网上抓的原文，这个是机器从声音里转出来的。
   * 有词的时候以歌词为准，转写只用来对位；没词（同人曲、live、视频、生放送）时才由它补位。
   * **只有本地那条路支持**：云端那条要另外给 prompt 加字段，这里先不开。
   */
  asrEnabled: boolean;
  /**
   * 交叉校验：再开一个 whisper 跑同一段，两边差太多就把这句标成「不确定」。
   *
   * **默认关。** 实测在唱段上 whisper（哪怕 large-v3）比 SenseVoice 更容易编——
   * 拿更会编的那个当裁判，会把正确答案判成错的。真要开，建议配 large-v3 并接受慢 5 秒。
   */
  asrCrossCheck: boolean;
  /** 交叉校验用哪一档 whisper。只在 asrCrossCheck 打开时有意义。 */
  asrWhisperTier: 'small' | 'medium' | 'large-v3';
  /** 允许她读这首歌的歌词。关了就只有听感，说不出词里在讲什么。 */
  lyricAware: boolean;
  /** 一次给她几行歌词。给多了她会复述，给少了没法评。 */
  lyricLines: number;
  /**
   * 打炉石时让路。
   *
   * 打开后：检测到 `Hearthstone.exe` 在跑就不主动开口（换歌、段落都不说），
   * 你戳她她还是照答 —— 让的是「主动播报」，不是「拒绝回答」。
   *
   * **默认关。** 两件事同时进行、各说各的，这是很多人喜欢的状态；
   * 只有嫌吵的人才需要打开。看到进程也不等于正在对局，挂在后台也会让路。
   */
  yieldToHearthstone: boolean;
}

export const MUSIC_DEFAULTS = (): MusicConfigSection => ({
  enabled: false, // 由 WorldSection 提供，扩展不能自己决定装上就开
  chatiness: 'normal',
  player: 'auto',
  intervalMs: 1000,
  extraPlayers: '',
  nightFrom: 23,
  longMinutes: 100,
  keepDays: 90,
  memoryDir: '',
  controlAllowed: true,
  segmentEverySec: 45,
  maxSegmentsPerTrack: 3,
  selfPick: false,
  pickSource: 'auto',
  pickWhen: 'ask',
  relayPick: true,
  soulWritable: true,
  audioReactive: true,
  hearingMode: 'cloud',
  hearingCloudKey: '',
  hearingCloudBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  hearingCloudModel: 'qwen-omni-turbo',
  hearingEverySec: 0,
  asrEnabled: true,
  asrCrossCheck: false,
  asrWhisperTier: 'medium',
  lyricAware: true,
  lyricLines: 2,
  yieldToHearthstone: false,
});

const P = (field: string): string => `worlds.${MUSIC_ID}.${field}`;

/**
 * 设置页。四组，每组一句话说清"改了会怎样"。
 *
 * 为什么不再堆成一组：十个字段一屏，最该调的（说话多不多）和最不该动的（采样间隔）
 * 混在一起，等于没分组。
 */
export function musicConfigGroups(): ConfigGroup[] {
  return [
    {
      id: 'music.talk',
      owner: `world:${MUSIC_ID}`,
      schema: {
        type: 'object',
        title: '她怎么开口',
        description: '换歌必说一句；一首歌里说几句、隔多久说，由这两项决定。',
        properties: {
          [P('chatiness')]: {
            type: 'string',
            title: '接话频率',
            description: '正常=换歌说一句，每段再说一句；安静=只在深夜、久听这类时刻开口，平时陪着你听，不评论。',
            enum: ['normal', 'quiet'],
          },
          [P('maxSegmentsPerTrack')]: {
            type: 'integer',
            title: '一首歌说几次',
            description: '不含开头那次。3 段的话：3 分半的歌约 52 秒一段，15 分钟的古典约 3 分 45 一段。调大就变密。',
            minimum: 0,
            maximum: 8,
            'x-suffix': '段',
          },
          [P('yieldToHearthstone')]: {
            type: 'boolean',
            title: '打炉石时让路',
            description: '打开后：检测到炉石在跑就不主动开口（换歌、段落都不说），你戳她还是照答；打完自动恢复。默认关——两件事同时进行、各说各的，很多人反而喜欢。注意：炉石挂在后台不动也算「在跑」，这时同样会安静。',
          },
          [P('segmentEverySec')]: {
            type: 'integer',
            title: '一段至少多长',
            description: '秒。段长的下限，也是第一段的长度——换完歌要尽快表态，这一段不参与均分。填 0 就只报换歌。',
            minimum: 0,
            maximum: 180,
            'x-suffix': '秒',
          },
        },
      },
    },
    {
      id: 'music.source',
      owner: `world:${MUSIC_ID}`,
      schema: {
        type: 'object',
        title: '从哪读',
        description: '读 Windows 的系统媒体会话（SMTC）。只有播放器不上报时才退回读窗口标题。',
        properties: {
          [P('player')]: {
            type: 'string',
            title: '两个播放器同时在放',
            description: '自动=谁在放听谁；也可以固定只听某一个。',
            enum: ['auto', 'qq', 'netease'],
          },
          [P('extraPlayers')]: {
            type: 'string',
            title: '还认哪些播放器',
            description: '逗号分隔的进程名片段，例如 spotify,foobar。留空则只认 QQ音乐和网易云。',
          },
          [P('intervalMs')]: {
            type: 'integer',
            title: '多久看一次',
            description: '毫秒。默认 1000，够用就别动。改完要重启扩展才生效。',
            minimum: 400,
            maximum: 5000,
            'x-suffix': 'ms',
            'x-hot': false,
          },
        },
      },
    },
    {
      id: 'music.pick',
      owner: `world:${MUSIC_ID}`,
      schema: {
        type: 'object',
        title: '她自己点歌',
        description: '打开之后她会自己去搜歌、挑一首、说清为什么想听，并给出链接。播放那一下仍要你来点——两个客户端都不接受从外部点播，原因写在 README 里。接力点歌让她一首接一首往下递，但每一棒仍然是你按播放。',
        properties: {
          [P('selfPick')]: {
            type: 'boolean',
            title: '允许她自己去搜歌挑歌',
            description: '关着的时候她只评价你在放的，不会去翻别的。打开后她想听什么会直接说，并记进想听清单。',
          },
          [P('relayPick')]: {
            type: 'boolean',
            title: '接力点歌（一首接一首）',
            description:
              '打开后：你放了她点的那首，剩约 35 秒时她把下一首也挑好递过来，最多连 6 首，没接就不追问。'
              + '播放还是你点一下。想让她真替你按，去桌宠那边开「电脑操作」——按宿主的规矩，她得先用气泡问你一句，你答应了才会动鼠标。',
          },
          [P('audioReactive')]: {
            type: 'boolean',
            title: '跟着真实的拍子动',
            description:
              '打开后她会听系统正在放的声音，算出 BPM，动作跟着真实的鼓点走——不再按写死的频率晃。'
              + '**她听到的是这台机器输出的所有声音**（会议、视频、提示音都在内），所以能关。'
              + '采集在本机完成，只算低音/响度/BPM 三个数，不录音、不存波形、不上传。'
              + '只有 Windows 有这条通路；关掉就回到按曲风选的固定节奏。',
          },
          [P('soulWritable')]: {
            type: 'boolean',
            title: '允许她写自己的口味档案',
            description:
              '她会把"我爱听什么"写进记忆目录的 music-soul.md，一条一行，整篇读进提示词。'
              + '关掉只是不让她写，她照样读得到。想亲手写这份文件就关掉它；它不会被「听歌记录保留 90 天」那条清理碰到。',
          },
          [P('pickSource')]: {
            type: 'string',
            title: '上哪个曲库找',
            description: '自动=两个库都搜再挑，有些冷门歌只有一边有；也可以固定只搜一家。',
            enum: ['auto', 'qq', 'netease'],
          },
          [P('pickWhen')]: {
            type: 'string',
            title: '什么时候可以挑',
            description: '问我才挑=你问她、或聊到想听什么的时候；自己挑=没歌在放的时候她可以主动挑一首，不用等你开口。',
            enum: ['ask', 'idle'],
          },
        },
      },
    },
    {
      id: 'music.lyric',
      owner: `world:${MUSIC_ID}`,
      schema: {
        type: 'object',
        title: '歌词',
        description: '打开之后她能知道这首歌此刻唱到哪一句，评价能落到词上，而不是只会说"鼓点不错"。歌词按歌名歌手去曲库反查，对不上就不给——宁可没有，也不能拿错歌的词去评。',
        properties: {
          [P('lyricAware')]: {
            type: 'boolean',
            title: '让她看歌词',
            description: '关掉之后她只有听感：能说编曲、唱腔、节奏，说不出词里在讲什么。打开时每段会附上刚唱过的一两句，需要联网查一次词。',
          },
          [P('lyricLines')]: {
            type: 'integer',
            title: '一次给她几行',
            description: '1–3。给两行她还能评，给三行以上她就容易照着念——那样听着像在念歌词，不是在聊天。',
            minimum: 1,
            maximum: 3,
            'x-suffix': '行',
          },
        },
      },
    },
    {
      id: 'music.hearing',
      owner: `world:${MUSIC_ID}`,
      schema: {
        type: 'object',
        title: '深听方式',
        description:
          '她本来只能听到拍子和响度（能量层）。想让她说得出调性、和弦、主旋律和乐器，就得「深听」——'
          + '把最近十几秒送去分析。两条路选一条：云端快、装上就能用，但要填密钥、音频会离开这台机器；'
          + '本地完全在本机跑、不联网，但要先下载约 500MB 的依赖和模型。'
          + '两条路都只分析十几秒的切片，不是整首总谱。',
        properties: {
          [P('hearingMode')]: {
            type: 'string',
            title: '走哪条路',
            description:
              '云端（默认）=填个密钥就能用，不占本机空间，十几秒切片会上传到所配的服务；'
            + '本地=本机分轨，音频不出这台机器，但要先下载约 500MB（Python 环境 + 六轨分离模型），第一次装要几分钟；'
            + '关=只保留拍子和响度，没有调性、和弦、旋律。',
            enum: ['cloud', 'local', 'off'],
          },
          [P('hearingCloudKey')]: {
            type: 'string',
            title: '云端密钥',
            description:
              '只用在「云端」这一档。以明文存在扩展配置里，只在本机读，不会写进记忆目录、也不会跟着同步盘走。'
              + '留空就只有能量层能用，她会照实说听不了。',
          },
          [P('hearingCloudBase')]: {
            type: 'string',
            title: '云端地址',
            description:
              'OpenAI 兼容的接口地址，写到 /v1 为止（默认是阿里云百炼）。'
              + '换成别家（例如 https://api.openai.com/v1）时，模型名也要一起换。',
          },
          [P('hearingCloudModel')]: {
            type: 'string',
            title: '云端模型',
            description:
              '必须支持音频输入。默认 qwen-omni-turbo；用 OpenAI 的话可以填 gpt-4o-mini-audio-preview。'
              + '填了个不支持音频的模型，回执会直接说请求被拒，不会静默失败。',
          },
          [P('hearingEverySec')]: {
            type: 'integer',
            title: '边听边攒（每隔几秒深听一段）',
            description:
              '0=关：只有你问「仔细听听」的时候才分析一次。'
              + '填 60 就是每首歌每分钟偷偷听一段，攒成这首的曲式档案，之后她评论时能说出「前面是钢琴，副歌进了鼓」。'
              + '**云端模式这一段就是一次计费调用**，所以默认是 0，想攒的人自己打开。',
            minimum: 0,
            maximum: 300,
            'x-suffix': '秒',
          },
          [P('asrEnabled')]: {
            type: 'boolean',
            title: '听出唱词（本机转写）',
            description:
              '打开后，本地深听会把人声那一轨送进本机语音识别，听出这段在唱什么——'
              + '不查歌词，是真的从声音里转出来的。12 秒约 0.2 秒，不联网。'
              + '**有歌词时以歌词为准**，转写只用来对位；没歌词的同人曲、live、视频、生放送才由它补位。'
              + '只有「走本地」这一条路支持。',
          },
          [P('asrCrossCheck')]: {
            type: 'boolean',
            title: '交叉校验（另开一个模型复核）',
            description:
              '再跑一个 whisper 复核同一段，两边差太多就把这句标成「不确定」，她就不许当原句引用。'
              + '**默认关**：实测在唱段上 whisper 比 SenseVoice 更容易编，拿更容易编的那个当裁判会误伤正确答案。'
              + '打开的话每次深听多花几秒。',
          },
          [P('asrWhisperTier')]: {
            type: 'string',
            title: '用哪档 whisper 复核',
            description:
              'small 体积最小但实测会退化成重复同一句；medium 内容基本对；large-v3 最干净但要 3.1GB、慢 5 秒左右。'
              + '只有打开「交叉校验」才有意义。',
            enum: ['small', 'medium', 'large-v3'],
          },
        },
      },
    },
    {
      id: 'music.moments',
      owner: `world:${MUSIC_ID}`,
      schema: {
        type: 'object',
        title: '特殊时刻',
        description: '两个只在特定条件下才触发的提醒，各只说一次，不反复念。',
        properties: {
          [P('nightFrom')]: {
            type: 'integer',
            title: '深夜从几点算',
            description: '0–23，窗口到清晨 5 点。这段时间还在听，她会开口一次。',
            minimum: 0,
            maximum: 23,
            'x-suffix': '点',
          },
          [P('longMinutes')]: {
            type: 'integer',
            title: '连续听多久算久',
            description: '分钟。达标时提醒一次休息。设很大等于关掉这条。',
            minimum: 20,
            maximum: 480,
            'x-suffix': '分',
          },
        },
      },
    },
    {
      id: 'music.data',
      owner: `world:${MUSIC_ID}`,
      schema: {
        type: 'object',
        title: '记录与位置',
        description: '听歌记录存在哪、留多久、她能不能替你按键，以及要不要自动补齐桌宠动作。',
        properties: {
          [P('memoryDir')]: {
            type: 'string',
            title: '记忆保存位置',
            description:
              '留空＝跟着这台机器。填一个同步盘或移动硬盘里的文件夹，公司和家里的桌宠就是同一份记忆（听过什么、给哪首写过笔记、欠你哪几首）。'
              + '换位置不会丢旧记录——本机原来那份仍然一起读。'
              + '两点要注意：别两台机器同时开着往同一个目录里写，网盘同步会打架；歌词缓存和「现在在放什么」永远留在本机，不跟着走。',
            'x-path': { kind: 'directory', recommendedDir: suggestedMemoryDir() },
          },
          [P('keepDays')]: {
            type: 'integer',
            title: '听歌记录保留',
            description: '天。超出的旧记录在下次启动时删掉。',
            minimum: 1,
            maximum: 365,
            'x-suffix': '天',
          },
          [P('controlAllowed')]: {
            type: 'boolean',
            title: '允许她替你按暂停/切歌',
            description: '关掉之后她只能看着，不能动你的播放器。',
          },
        },
      },
    },
  ];
}
