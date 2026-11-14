/** 包入口：默认导出 WorldDefinition，装载器按 cortico.kind === 'world' 认它。 */
import { MUSIC } from './definition.ts';

export default MUSIC;
export { MUSIC };
export { MusicWorld, MUSIC_DESCRIBE, EVENT_DECLS } from './world.ts';
export { MUSIC_DEFAULTS, MUSIC_ID, musicConfigGroups, type MusicConfigSection, type Chatinness } from './config.ts';
export { NowPlayingBridge } from './nowplaying.ts';
export { ListeningTracker } from './tracker.ts';
export { ListenStore, summarize } from './history.ts';
