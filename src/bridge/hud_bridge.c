/*
 * hud_bridge.c -- MO/YR 观战数据桥（只读，给 OBS 用）
 * v6 (2026-10-18)：v5实测缺陷修复
 *   D1 观察者房从 players[] 剔除（is_observer_house 标记），name 兜底 <human player>；
 *   D2/D3 中文昵称/地图名：rd_wstr 改 UTF-16 直读 + to_utf8_wide；
 *   D4 单位聚合排序加 id 字典序次级键（稳定）；
 *   D5 形态单位按 morph_map 归一到主形态（DEVO+DEVOD 合计）；
 *   P1  删除死字段 value；P2 顶层新增 uagg_dropped。
 * v6.1 (2026-10-19)：输出口径修正（无新增键，仅修正过滤条件）
 *   观察者房判定与输出过滤解耦：只有真正空镜头观战（is_observer=1）才剔除观察者房，
 *   否则共享模式（is_observer=0）下所有 human 且 spawn=-1 的玩家会被误删。
 * v6.2 (2026-10-21)：每玩家新增 infiltration 对象（只读 5 个现有 bool 位）
 *   {"side0","side1","side2","barracks","war_factory"}
 *   barracks/war_factory 为真 → 该玩家新造步兵/载具直接老兵，渲染端换 AltCameo。
 * v6.3 (2026-10-21)：顶层新增 screen 对象，schema 1 -> 2（其余键零变化）
 *   输出游戏渲染像素矩形：width/height（Primary 表面）、configured/shell（GameOptions）、
 *   windowed、sidebar_side、view_rect / sidebar_rect / window_rect（DSurface 三个全局矩形）、
 *   sidebar_surface（侧栏表面尺寸）、radar_rect / radar_view_rect / radar_scale。
 *   渲染端据此对齐"覆盖原版建造栏"，不再用 15.5% 之类的比例硬编码。
 *   screen.valid=false 表示读布局失败（未进对局/表面未建）；此时各矩形为 0，前端应退回默认布局。
 *   注：view 对象里的是地图格坐标，screen 里的是像素，两者不可混用。
 *
 * v6.4 (2026-10-21)：--record FILE.jsonl 追加模式
 *   每帧追加一行 {"tick":..., "state":{...}}，避免退出时 out/hud_state.json 被 ok:false 覆盖后
 *   丢失局内样本。键空间与 out 完全一致（schema 仍为 2）。
 * v6.5 (2026-10-22)：unit_types 两处读取缺陷修复（键不变，仅取值正确）
 *   D6  Veterancy @+0x150 是 float（4 字节），原按 8 字节 double 读 → 恒为 0；
 *       现改 rd_f32，阈值 0.5/1.5 不变。
 *   D7  同型单位聚合时 hp/vet 在读取之前就 continue，第 2 个及以后的单位只加 count，
 *       hp 恒等于首个单位的血量（实测 4165 个多单位样本里 4130 个 hp == 单兵满血）。
 *       现把 hp/vet 读取提到聚合循环之前。
 * v6.6 (2026-10-23)：守护模式 + 生产队列（schema 仍为 2，只新增键）
 *   Q   每玩家新增 queues 对象：building/defense/infantry/vehicle/navy/aircraft，
 *       每通道 {id,pct,suspended,next[]}。归属按 FactoryClass.Owner + House 主工厂槽
 *       （0x53AC/53B0/53B4/53B8/53BC/53CC），不依赖 BuildCat/Naval 这两个未实测字段。
 *       只有 active 的通道才出现；空通道整个键省略，渲染端画"空闲"。
 *       pct = Progress(+0x24) / 54 * 100，54 是引擎硬编码（IsDone@0x4CA130 比 0x36）。
 *   D   桥改成常驻守护：游戏退出不再 break，回到等待态并在 2 秒内重挂新 pid。
 *       handle 判活（pid 会被复用）。主循环仍按 interval 写文件，未挂上时 1s 一次。
 *   P   顶层新增 phase / client_running：no_client / lobby / loading / match / post_match。
 *       渲染端据此区分"桥停了"与"客户端/对局还没起"。
 *   S   单实例命名互斥体，避免双击两次产生两个桥同时写同一 JSON。
 *   L   进程定位优先选 exe 路径位于 HKCU\SOFTWARE\Westwood\Mental Omega\InstallPath
 *       之下的实例——原版 YR 与 MO 的 gamemd.exe 同 MD5/TimeDateStamp，preflight 分不开。
 * v6.7 (2026-10-23)：守护句柄权限修复 + 运行时队列诊断
 *   X   OpenProcess 补 SYNCHRONIZE。v6.6 只申请 QUERY_INFORMATION|VM_READ，
 *       WaitForSingleObject 对这样的句柄恒返回 WAIT_FAILED(ERROR_ACCESS_DENIED)，
 *       于是"游戏退出"永远检测不到、g_proc 永不释放：第一局结束后桥一直读已退出的
 *       pid，第二局不再重挂，整局输出 pid 不变 / phase=loading / ok=false / frame=0。
 *       实测（同一台机器，x86，对本进程自身）：无 SYNCHRONIZE → ret=0xFFFFFFFF err=5；
 *       有 → ret=WAIT_TIMEOUT。另加 GetExitCodeProcess 兜底 WAIT_FAILED。
 *   G   --diag-queues [秒]：只读诊断模式，逐环打印
 *       FactoryClass 数组 → Owner(+0x6C) → House 主工厂槽(0x53AC..0x53CC) →
 *       Object/QueuedObjects 的类型解析，定位"队列为空"断在哪一环。
 *       不写 hud_state.json，可与守护桥同时运行。
 * v6.8 (2026-10-25)：载具乘员计入单位构成（键不变，仅统计口径）
 *   R15 limbo 过滤放宽：InLimbo 且 Transporter(+0x11C) 非空 = 在载具内，计回 unit_types；
 *       工厂排队/待部署等其余 limbo 仍剔除；乘员按自身 Owner 归属（敌运我兵归我）。
 *       偏移依据：YRpp TechnoClass 布局（Passengers 0x114 / Transporter 0x11C），
 *       字节级复核 gamemd EnterAsPassenger cmp[esi+0x114] 与 CanFire 0x6FC5C7 读 +0x11C。
 *       驻楼步兵走 BuildingClass::Occupants 向量、不在此机制内，维持不计。
 * v6.9 (2026-10-26)：子机与载荷占位体不计入单位构成（键不变，仅统计口径）
 *   R16 两道类型层闸，均在读到 TechnoTypeClass* 之后、读 ID 之前：
 *   ① Spawned(+0x0D54) 为真 → 剔除。母舰/鸟巢/导弹释放的子机（HORNET/ASW/SHRIKE/
 *      *ROCKET/*MISL 共 35 型）停靠时 InLimbo=1 被原有 limbo 分支挡掉，但放飞后
 *      InLimbo=0 会直接进 unit_types，数量随起降来回跳。Spawned 声明在 TechnoTypeClass
 *      基类上，Unit/Infantry/Aircraft 三个子类共用同一偏移，故对三张表统一生效
 *      （MO 3.3.6 里全部 35 个 Spawned 型都在 AircraftTypes，载具/步兵侧不会误伤）。
 *      偏移依据：MSVC offsetof(YRpp TechnoTypeClass) = 0x0D54，且与 +0x0D58 Spawns、
 *      +0x0D5C SpawnsNumber、+0x0D68 MissileSpawn 顺序自洽；
 *      gamemd 0x419B25 mov eax,[esi+0x6c4] → 0x419B2B mov cl,[eax+0xd54]
 *      test cl,cl / jne（AircraftClass 空袭任务里判"本机是子机"转向 SpawnOwner）。
 *   ② 显式载荷占位体表 g_dummy：SALA_1/SALA_2/SUNB_1/MAGNET_1/MAGNET_2/CYCL_1 等
 *      Image=FAKEP 的 InitialPayload 假单位，被 R15 乘员分支计回后表现为"1 辆 + 4 条"。
 *      走 ID 表而不用 DontScore/Insignificant 偏移：这三个 bool 偏移无语义级复盘点，
 *      误读会静默吞掉真单位；ID 表与 g_morph 同一种做法，可逐条对照 rules.ini。
 *      刻意保留：SLAV（Slave Worker，DontScore 但可选中）、MAGNET（超武投放实体）、
 *      DRACOD（飞蜥炮台，能打能选，只是出自 InitialPayload）。
 *   顶层新增 uagg_skipped：被上面两道闸剔除的对象数（诊断用，0 表示本局无子机/占位体）。
 * v7.0 (2026-10-26)：Esc/选项菜单探测（schema 2，只加键；真机未验证）
 *   R22 顶层新增 menu_open / menu{dialogs,owner_draw,visible}：
 *   多人局按 Esc 不会置 ScenarioClass::IsGamePaused(+0x630)——引擎只在单机暂停时置位，
 *   所以 v6.8 的 paused 在多人局恒为假，"暂停隐藏队列"永远不触发。
 *   菜单形态无法从静态分析唯一确定：PE 资源 RT_DIALOG 里有 533x369 的
 *   IGMultiOpt/IGGameOpt 模板（控件标签 STT:IGMultiOptButtonResume、
 *   STT:IGGameOptButtonBack 等，且样式带 WS_CHILD 0x40000000），走的是
 *   CreateDialogParamA/CreateDialogIndirectParamA + DlgProc（Ares 的
 *   OptionsDlg_WndProc_* 钩子即该对话框过程）；但同一模块里也有
 *   .?AVGraphicMenu@@ / GraphicMenuItem 一族 RTTI 自绘菜单。两者可能同时存在
 *   （Esc 主菜单自绘、选项页是对话框）。因此输出两条独立信号 + 原始值：
 *   ① menu.dialogs：EnumWindows + EnumChildWindows 遍历游戏 pid 的窗口树，
 *      数可见的 "#32770" 类。纯 User32 查询，不读游戏内存。
 *   ② menu.owner_draw：OwnerDraw 的模型态对话框栈深度 0xB72F50。
 *      Dialog_Show(0x622670) 创建时先 inc 再写回（0x62267f→0x6226a4），
 *      销毁路径 dec 后写回（0x622788→0x6227a1）；0x775701/0x77583b 是同一对。
 *      限幅 1..4 才采信，脏数据不会把菜单判成常开。
 *   menu_open = dialogs>0 || owner_draw>0。真机对局时看这两个原始值就知道
 *   哪条信号在起作用；若两条都恒 0，说明 Esc 界面两者都不是，需要重新定位。
 *   刻意保留 paused：单机/观战暂停时仍有效，渲染端另有用途（计时冻结）。
 *
 * [TEMP-OBS-GATE-OFF 2026-10-21] 测试期临时禁用观察者判断：
 *   emit_json / emit_text 里"剔除观察者房"的两行用 #if 0 关掉，非观察者也输出全量玩家。
 *   发布前删除两处 #if 0 / #endif 即恢复 v6.1 口径（渲染端若重写需自行按 is_observer_house 过滤）。
 *
 * 绑定: gamemd.exe YR 1.001, ImageBase 0x400000, TimeDateStamp 0x3BDF544E。
 *   两个等价构建：原版 1.001 = 937b14db32f07ee47e92a8114ebdbdde，
 *   MO 3.3.6 安装体 = fe2301a1f48841aa084aade100b25335（同尺寸同时间戳，
 *   cncnet5 的 .patch 节改写代码但不动布局）。preflight 只校验 Machine+TimeDateStamp。
 * 只用 OpenProcess(PROCESS_VM_READ) + ReadProcessMemory，不写进程、不注入、不 hook。
 *
 * bridge 是"给机器看的实时数据源"：每 N 毫秒原子地覆盖写一个 JSON + 一个纯文本，
 * OBS 的"文本(GDI+/FreeType)"源读 hud_text.txt，浏览器源读 hud_state.json。
 *
 * 用法:
 *   hud_bridge.exe                                  守护模式：自动等游戏，500ms 刷新
 *   hud_bridge.exe --pid N                          固定目标 pid（重启后仍用同 pid）
 *   hud_bridge.exe --interval 250                   刷新间隔（毫秒，最小 100）
 *   hud_bridge.exe --out out\hud_state.json          JSON 路径
 *   hud_bridge.exe --text out\hud_text.txt           文本路径（可给 --no-text 关掉）
 *   hud_bridge.exe --supers 8                        每个玩家最多输出几颗超武
 *   hud_bridge.exe --record FILE.jsonl               逐帧追加（含 match_end 分隔行）
 *   hud_bridge.exe --dump-screen                     只打印一次布局+队列摘要后退出
 *   hud_bridge.exe --diag-queues [秒]                队列诊断：工厂数组/Owner/主工厂槽/类型解析
 *   hud_bridge.exe --dry-run                         不连游戏，写一份示例数据用于调试 OBS
 *
 * 编译:
 *   cl /nologo /MT /O2 hud_bridge.c /Fe:hud_bridge.exe /link psapi.lib winmm.lib
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmsystem.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <psapi.h>
#include <tlhelp32.h>

/* ---- globals (与 hud_probe4.c 一致，均由 offsetof 求出) ---- */
#define A_HOUSE_ARRAY        0x00A80228u
#define A_HOUSE_ITEMS        0x00A8022Cu
#define A_HOUSE_COUNT        0x00A80238u
#define A_CURRENT_PLAYER     0x00A83D4Cu
#define A_OBSERVER           0x00AC1198u
#define A_OBSERVER_MODE      0x00AC10C8u
#define A_CURRENT_FRAME      0x00A8ED84u
#define A_SESSION            0x00A8B238u
#define A_SCENARIO           0x00A8B230u
#define A_GAMEMODE_OPTIONS   0x00A8B250u
#define A_NODENAME_ARRAY     0x00A8DA74u
#define A_SUPER_ARRAY        0x00A83CB8u
#define A_TACTICAL           0x00887324u
#define A_MAP_INSTANCE       0x0087F7E8u
#define A_VIEW_BOUNDS        0x00B0CE28u
/* 屏幕 / 侧栏像素矩形（v6.3）：地址与语义见 前端开发/04-屏幕与游戏UI布局字段.md */
#define A_PRIMARY_SURFACE    0x00887308u   /* DSurface::Primary 指针变量 */
#define A_SIDEBAR_SURFACE    0x00887300u   /* DSurface::Sidebar 指针变量 */
#define A_GAME_OPTIONS       0x00A8EB60u   /* GameOptionsClass::Instance（内联对象，非指针） */
#define A_WINDOWED_MODE      0x0089F978u
#define A_SIDEBAR_BOUNDS     0x00886F90u   /* DSurface::SidebarBounds */
#define A_DSURF_VIEW_BOUNDS  0x00886FA0u   /* DSurface::ViewBounds（战术视口） */
#define A_WINDOW_BOUNDS      0x00886FB0u   /* DSurface::WindowBounds */
#define GO_SIDEBAR_MODE      0x001C        /* bool，1=右 0=左 */
#define GO_SCREEN_W          0x0024
#define GO_SCREEN_H          0x0028
#define GO_SHELL_W           0x002C
#define GO_SHELL_H           0x0030
#define SURF_WIDTH           0x0004        /* XSurface::Width */
#define SURF_HEIGHT          0x0008        /* XSurface::Height */
#define R_RADAR_SCALE        0x1488        /* RadarClass::RadarSizeFactor (float) */
#define R_RADAR_RECT         0x149C        /* RadarClass::RadarRect；坐标空间待实测 */
#define R_RADAR_VIEW_RECT    0x14DC        /* RadarClass::RadarViewRect */
#define A_BUILDING_ARRAY     0x00A8EB40u
#define A_BUILDING_ARRAY_ITEMS (A_BUILDING_ARRAY + V_ITEMS)
#define A_BUILDING_ARRAY_COUNT (A_BUILDING_ARRAY + V_COUNT)

/* 单位数组（hud_probe4.c 同源） */
#define A_UNIT_ARRAY         0x008B4108u
#define A_INFANTRY_ARRAY     0x00A83DE8u
#define A_AIRCRAFT_ARRAY     0x00A8E390u

/* 各对象子类的 Type 指针偏移（vtable 布局差异，P1-2 已核验） */
#define UT_TYPE              0x06C4   /* UnitClass  / AircraftClass 同偏移 */
#define IT_TYPE              0x06C0   /* InfantryClass */
#define BT_TYPE              0x0520   /* BuildingClass */

#define EXPECT_MACHINE       0x014Cu
#define EXPECT_TIMEDATE      0x3BDF544Eu

/* HouseClass */
/* 六个主工厂槽（FactoryClass*）：GetPrimaryFactory@0x500510 的五个 case 分派目标。
   0x53C0/0x53C4/0x53C8 是 Primary_Unused1/2/3，反汇编确认任何 case 都不读写，勿用。 */
#define H_PRIMARY_AIRCRAFT   0x53AC
#define H_PRIMARY_INFANTRY   0x53B0
#define H_PRIMARY_VEHICLES   0x53B4
#define H_PRIMARY_SHIPS      0x53B8
#define H_PRIMARY_BUILDINGS  0x53BC
#define H_PRIMARY_DEFENSES   0x53CC
#define H_INDEX              0x0030
#define H_TYPE               0x0034
#define H_AI_DIFFICULTY      0x0184
#define H_SIDE_INDEX         0x01E8
#define H_IS_HUMAN           0x01EC
#define H_IS_IN_CTRL         0x01ED
#define H_DEFEATED           0x01F5
#define H_IS_GAMEOVER        0x01F6
#define H_IS_WINNER          0x01F7
#define H_IS_LOSER           0x01F8
#define H_IP                 0x0200
#define H_TEAM_ID            0x0204
#define H_LOST_CONNECTION    0x0208
#define H_HAS_BEEN_SPIED     0x0243
#define H_HAS_BEEN_THIEVED   0x0244
#define H_IS_RESIGNER        0x0247
#define H_IS_GIVERUPPER      0x0248
#define H_SUPERS             0x0254
/* 间谍渗透获得的生产力（YRpp HouseClass.h）：
   Side*TechInfiltrated = 渗透敌方对应阵营的建筑后，解锁 RequiresStolen*Tech 条目；
   Barracks/WarFactoryInfiltrated = 渗透过敌方兵营/重工，之后【己方】新造的
   步兵/载具直接老兵（原版行为，MO 用 Ares SpyEffect.UnitVeterancy 扩展为多类）。
   归属：按 YR/Ares 语义，这三个老兵位挂在【渗透方】的 HouseClass 上（受益者）；
   进游戏实测时需确认一次归属，若相反只需交换读取对象。
   bridge 只输出原始位，不做推导。 */
#define H_SIDE2_TECH_INFILTRATED 0x02BC
#define H_SIDE1_TECH_INFILTRATED 0x02BD
#define H_SIDE0_TECH_INFILTRATED 0x02BE
#define H_BARRACKS_INFILTRATED   0x02BF
#define H_WAR_FACTORY_INFILTRATED 0x02C0
#define H_CREDITS_SPENT      0x02DC
#define H_HARVESTED          0x02E0
#define H_STOLEN_CREDITS     0x02E4
#define H_OWNED_UNITS        0x02E8
#define H_OWNED_NAVY         0x02EC
#define H_OWNED_BUILDINGS    0x02F0
#define H_OWNED_INFANTRY     0x02F4
#define H_OWNED_AIRCRAFT     0x02F8
#define H_OWNED_TIBERIUM     0x02FC
#define H_BALANCE            0x030C
#define H_TOTAL_STORAGE      0x0310
#define H_KILLS_OF_HOUSES    0x53E4
#define H_LOST_UNITS         0x5434
#define H_KILLS_BLD_OF_HOUSES 0x5438
#define H_LOST_BUILDINGS     0x5488
#define H_POINT_TOTAL        0x54E8
#define H_COLOR              0x56F9
#define H_BASE               0x5700
#define H_ALLIES             0x5788
#define H_PLAIN_NAME         0x15FF4
#define H_UINAME             0x1602A
#define H_TOTAL_INF_COST     0x160A8
#define H_TOTAL_VEH_COST     0x160AC
#define H_TOTAL_AIR_COST     0x160B0
#define H_POWER_OUT          0x53A4
#define H_POWER_DRAIN        0x53A8
#define H_WHO_LAST_HURT_ME   0x548C
#define H_POWER_SURPLUS      0x160B4

/* BaseClass */
#define B_PERCENT_BUILT      0x001C
#define B_CENTER             0x0050

/* type */
#define T_ID                 0x0024
#define T_PARENT_COUNTRY     0x0098
#define TY_STRENGTH          0x00A0   /* TechnoTypeClass 最大血量 */

/* vectors */
#define V_ITEMS              0x04
#define V_CAPACITY           0x08
#define V_COUNT              0x10

/* FactoryClass（Array@0xA83E30；构造函数 sub_4E6E60 写入 Items/CapInc/Count） */
#define A_FACTORY_ARRAY      0x00A83E30u
#define A_FACTORY_ITEMS      (A_FACTORY_ARRAY + V_ITEMS)
#define A_FACTORY_COUNT      (A_FACTORY_ARRAY + V_COUNT)
#define F_PROGRESS           0x0024   /* StageClass::Value，0..54（GetProgress@0x4CA120 = [ecx+24h]） */
#define F_QUEUE_ITEMS        0x0044   /* QueuedObjects.Items */
#define F_QUEUE_COUNT        0x0050   /* QueuedObjects.Count */
#define F_OBJECT             0x0058   /* 正在生产的 TechnoClass*，可为 null（IsDone@0x4CA130 读） */
#define F_OWNER              0x006C   /* HouseClass* */
#define F_IS_SUSPENDED       0x0070   /* 完工待放置/手动暂停 */
#define PROGRESS_DONE        54       /* 引擎硬编码 54 步（0x36），不是 100 */

/* 各实体类的 vtable 地址：用对象首 DWORD 匹配，决定 Type 该按哪个偏移读。 */
#define VT_UNIT_CLASS        0x007F5C70u
#define VT_AIRCRAFT_CLASS    0x007E22A4u
#define VT_INFANTRY_CLASS    0x007EB058u
#define VT_BUILDING_CLASS    0x007E3EBCu

/* 各 Type 类的 vtable：仅诊断用，用来判断 Object 指向的到底是不是类型对象。 */
#define VT_UNIT_TYPE_CLASS     0x007F6218u
#define VT_INFANTRY_TYPE_CLASS 0x007EB610u
#define VT_BUILDING_TYPE_CLASS 0x007E4570u
#define VT_AIRCRAFT_TYPE_CLASS 0x007E2868u

/* object */
#define O_IS_ALIVE           0x0090
#define O_IN_LIMBO           0x0081
#define O_OWNER              0x021C
#define O_LOCATION           0x009C
#define O_HEALTH             0x006C   /* TechnoClass 当前血量 */
#define O_VETERANCY          0x0150   /* float，1.0=老兵 2.0=精英（v6.5 修正：原按 double 读，恒得 0） */
#define O_TRANSPORTER        0x011C   /* R15：TechnoClass::Transporter，非空=本单位在载具内（Passengers 0x114 之后）*/

/* type：类型层静态属性（v6.9/R16） */
#define TY_SPAWNED           0x0D54   /* TechnoTypeClass::Spawned，非 0 = 由母体释放的子机 */

/* super */
#define S_CUSTOM_CHARGE      0x0024
#define S_TYPE               0x0028
#define S_OWNER              0x002C
#define S_RECHARGE_TIMER     0x0030
#define S_IS_PRESENT         0x006D
#define S_IS_READY           0x006F
#define S_IS_SUSPENDED       0x0070
#define SWT_RECHARGE_TIME    0x00B0

/* session / scenario */
#define SE_GAMEMODE          0x0000
#define SE_MPLAYER_MAX       0x0310
#define SE_MPLAYER_COUNT     0x0314
#define SE_OUT_OF_SYNC       0x068A
#define SE_SCENARIO_FILENAME 0x06A8
#define SC_ELAPSED_TIMER     0x0614
#define SC_IS_PAUSED         0x0630
#define SC_NAME              0x1360
#define SC_UINAME            0x13BA
#define SC_FILENAME          0x125C
#define SC_HOUSE_INDICES     0x1180
#define SC_START_X           0x112C
#define SC_START_Y           0x1130
#define SC_WIDTH             0x1134
#define SC_HEIGHT            0x1138
/* OwnerDraw 的模型态对话框栈深度（v7.0/R22）。Dialog_Show 创建时 inc 写回
   （0x62267f → 0x6226a4），销毁路径 dec 写回（0x622788 → 0x6227a1）；
   0x775701/0x77583b 是同一对。用于判定 Esc/选项菜单是否开着。 */
#define A_OWNERDRAW_DLG_DEPTH 0x00B72F50u
#define GO_MONEY             0x000C
#define GO_GAMESPEED         0x0018
#define GO_BASES             0x0008
#define GO_BRIDGES           0x0010
#define GO_CRATES            0x0011
#define GO_SHORTGAME         0x0012
#define GO_SWALLOWED         0x0013
#define GO_ALLIES            0x00CC

/* tactical */
#define TC_TACTICAL_POS      0x00B0
#define TC_ZOOM              0x00C0
#define TC_MAP_COORDS        0x0D80

/* map */
#define MAP_RECT             0x00EC
#define MAP_VALID_CELLS      0x006C

#define MAX_HOUSES 64
#define MAX_SUPERS 64
#define MAX_UNITTYPES 32   /* 每玩家最多列出的类型数（按数量排序截断） */

static HANDLE g_proc = NULL;
static int    g_fail = 0;

/* ------------------------------------------------------------------ */
/* 读取                                                                */
/* ------------------------------------------------------------------ */
static int rd(DWORD addr, void *buf, SIZE_T n)
{
    SIZE_T got = 0;
    if (!g_proc || !addr) { g_fail++; return 0; }
    if (!ReadProcessMemory(g_proc, (LPCVOID)(ULONG_PTR)addr, buf, n, &got) || got != n) {
        g_fail++; return 0;
    }
    return 1;
}
static int rd_u32(DWORD a, DWORD *v) { return rd(a, v, 4); }
static int rd_i32(DWORD a, int *v)   { return rd(a, v, 4); }
static int rd_u8 (DWORD a, BYTE *v)  { return rd(a, v, 1); }
static int rd_i16(DWORD a, int *v)   { short s = 0; int r = rd(a, &s, 2); *v = s; return r; }
static int rd_f32(DWORD a, float *v) { return rd(a, v, 4); }
/* 读 4 个 int32 的 RectangleStruct；失败返回 0（数组保持原样） */
static int rd_rect(DWORD a, int *out)
{
    int t[4];
    if (!rd(a, t, sizeof(t))) return 0;
    out[0] = t[0]; out[1] = t[1]; out[2] = t[2]; out[3] = t[3];
    return 1;
}
static void to_utf8_wide(const wchar_t *src, char *dst, int dstn);   /* 定义在后 */
static void rd_str(DWORD a, char *dst, int n)
{
    int i; char c;
    dst[0] = 0;
    for (i = 0; i < n - 1; ++i) {
        if (!rd(a + i, &c, 1) || !c) break;
        dst[i] = c; dst[i + 1] = 0;
    }
}
static void rd_wstr(DWORD a, char *dst, int n)
{
    /* UTF-16 宽字符直读 -> UTF-8（v6：不再把 >=128 的字符降级成 '?'） */
    wchar_t wbuf[256];
    int i;
    int maxc = (n > 1) ? (n - 1) : 0;
    if (maxc > 255) maxc = 255;
    dst[0] = 0;
    for (i = 0; i < maxc; ++i) {
        if (!rd(a + i * 2, &wbuf[i], 2) || !wbuf[i]) break;
    }
    wbuf[i] = 0;
    to_utf8_wide(wbuf, dst, n);
}

/* ANSI(GBK) / UTF-16 -> UTF-8 */
static void to_utf8_ansi(const char *src, char *dst, int dstn)
{
    wchar_t wbuf[512];
    int wl, ml;
    dst[0] = 0;
    if (!src || !src[0]) return;
    wl = MultiByteToWideChar(CP_ACP, 0, src, -1, wbuf, 512);
    if (wl <= 0) { lstrcpynA(dst, src, dstn); return; }
    ml = WideCharToMultiByte(CP_UTF8, 0, wbuf, -1, dst, dstn, NULL, NULL);
    if (ml <= 0) dst[0] = 0;
}
static void to_utf8_wide(const wchar_t *src, char *dst, int dstn)
{
    /* 先转到大缓冲再截断：dstn 不足时 WideCharToMultiByte 会整体失败清空，不能直接用 */
    char big[1024];
    int ml;
    dst[0] = 0;
    if (!src || !src[0]) return;
    ml = WideCharToMultiByte(CP_UTF8, 0, src, -1, big, sizeof(big), NULL, NULL);
    if (ml <= 0) return;
    lstrcpynA(dst, big, dstn);
}

/* ------------------------------------------------------------------ */
/* 字符串缓冲                                                          */
/* ------------------------------------------------------------------ */
typedef struct { char *p; size_t n, cap; } SB;

static void sb_init(SB *b)
{
    b->cap = 1 << 16; b->n = 0;
    b->p = (char *)malloc(b->cap);
    if (b->p) b->p[0] = 0;
}
static void sb_free(SB *b) { if (b->p) { free(b->p); b->p = NULL; } b->n = b->cap = 0; }
static void sb_need(SB *b, size_t extra)
{
    if (!b->p) return;
    if (b->n + extra + 1 > b->cap) {
        size_t nc = b->cap;
        while (b->n + extra + 1 > nc) nc *= 2;
        b->p = (char *)realloc(b->p, nc);
        if (b->p) b->cap = nc;
    }
}
static void sb_add(SB *b, const char *s)
{
    size_t l;
    if (!b->p || !s) return;
    l = strlen(s);
    sb_need(b, l);
    if (!b->p) return;
    memcpy(b->p + b->n, s, l);
    b->n += l; b->p[b->n] = 0;
}
static void sb_printf(SB *b, const char *f, ...)
{
    char tmp[4096];
    va_list ap;
    if (!b->p) return;
    va_start(ap, f);
    _vsnprintf(tmp, sizeof(tmp) - 1, f, ap);
    va_end(ap);
    tmp[sizeof(tmp) - 1] = 0;
    sb_add(b, tmp);
}
/* JSON 字符串（已转 UTF-8 的内容直接转义即可） */
static void sb_json(SB *b, const char *s)
{
    const unsigned char *p = (const unsigned char *)s;
    sb_add(b, "\"");
    if (p) {
        while (*p) {
            switch (*p) {
                case '"':  sb_add(b, "\\\""); break;
                case '\\': sb_add(b, "\\\\"); break;
                case '\n': sb_add(b, "\\n"); break;
                case '\r': sb_add(b, "\\r"); break;
                case '\t': sb_add(b, "\\t"); break;
                default:
                    if (*p < 0x20) sb_printf(b, "\\u%04x", *p);
                    else { char c[2]; c[0] = (char)*p; c[1] = 0; sb_add(b, c); }
            }
            ++p;
        }
    }
    sb_add(b, "\"");
}

/* 原子写：先写 .tmp 再替换，避免 OBS 读到半截文件 */
static int write_atomic(const char *path, const char *data, size_t len)
{
    char tmp[MAX_PATH + 8];
    FILE *f;
    if (!path || !path[0]) return 0;
    sprintf(tmp, "%s.tmp", path);
    f = fopen(tmp, "wb");
    if (!f) return 0;
    if (len && fwrite(data, 1, len, f) != len) { fclose(f); DeleteFileA(tmp); return 0; }
    fclose(f);
    if (!MoveFileExA(tmp, path, MOVEFILE_REPLACE_EXISTING)) {
        DeleteFileA(path);
        if (!MoveFileExA(tmp, path, MOVEFILE_REPLACE_EXISTING)) { DeleteFileA(tmp); return 0; }
    }
    return 1;
}

/* ------------------------------------------------------------------ */
/* 进程定位                                                            */
/* ------------------------------------------------------------------ */

/* 读取 MO 客户端写入的安装路径（HKCU\SOFTWARE\Westwood\Mental Omega\InstallPath）。
   客户端 WriteInstallPathToRegistry 写的就是这个键；没有或读不到就返回空串，
   此时退化成"只按名字找进程"。 */
static const char *install_dir(void)
{
    static char buf[MAX_PATH];
    static int done = 0;
    if (!done) {
        HKEY k;
        buf[0] = 0;
        if (RegOpenKeyExA(HKEY_CURRENT_USER, "SOFTWARE\\Westwood\\Mental Omega",
                          0, KEY_QUERY_VALUE, &k) == ERROR_SUCCESS) {
            DWORD type = 0, n = sizeof(buf) - 1;
            if (RegQueryValueExA(k, "InstallPath", NULL, &type, (LPBYTE)buf, &n) == ERROR_SUCCESS &&
                (type == REG_SZ || type == REG_EXPAND_SZ)) {
                buf[n] = 0;
                {   /* 统一成正斜杠、去尾斜杠，方便前缀比较 */
                    char *p = buf;
                    for (; *p; ++p) if (*p == '\\') *p = '/';
                    while (*buf && buf[strlen(buf) - 1] == '/') buf[strlen(buf) - 1] = 0;
                }
            }
            RegCloseKey(k);
        }
        done = 1;
    }
    return buf;
}

/* 该 pid 的 exe 全路径是否位于 MO 安装目录下。读不到路径就当"不是"。 */
static int proc_in_install_dir(DWORD pid)
{
    const char *dir = install_dir();
    HANDLE h;
    char path[MAX_PATH];
    DWORD n = MAX_PATH;
    int hit = 0;
    if (!dir || !dir[0]) return 0;
    h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) return 0;
    path[0] = 0;
    if (QueryFullProcessImageNameA(h, 0, path, &n)) {
        char *p = path;
        for (; *p; ++p) if (*p == '\\') *p = '/';
        if (!_strnicmp(path, dir, strlen(dir))) hit = 1;
    }
    CloseHandle(h);
    return hit;
}

/* 枚举所有进程，按 exe 名匹配（不区分大小写）。返回找到的第一个 pid。
   多实例时优先选 exe 全路径位于 MO 安装目录下的那个——原版 YR 的 gamemd.exe
   与本二进制同 MD5、同 TimeDateStamp，preflight 无法区分，只能靠路径。 */
static DWORD find_proc_by_name(const char *name, int prefer_install_dir)
{
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    PROCESSENTRY32 pe;
    DWORD pid = 0, fallback = 0;
    if (snap == INVALID_HANDLE_VALUE) return 0;
    pe.dwSize = sizeof(pe);
    if (Process32First(snap, &pe)) {
        do {
            if (_stricmp(pe.szExeFile, name)) continue;
            if (!prefer_install_dir) { pid = pe.th32ProcessID; break; }
            if (!fallback) fallback = pe.th32ProcessID;
            if (proc_in_install_dir(pe.th32ProcessID)) { pid = pe.th32ProcessID; break; }
        } while (Process32Next(snap, &pe));
    }
    CloseHandle(snap);
    return pid ? pid : fallback;
}

static DWORD find_gamemd(void)
{
    DWORD pid;
    pid = find_proc_by_name("gamemd.exe", 1);
    if (!pid) pid = find_proc_by_name("gamemd-spawn.exe", 1);
    return pid;
}

/* MO 客户端：三个渲染器变体，任一在跑都算客户端活着。
   MentalOmegaClient.exe 是引导器，起完 clientdx 就退出，不能拿它判断。 */
static DWORD find_client(void)
{
    DWORD pid;
    if ((pid = find_proc_by_name("clientdx.exe", 0)) != 0) return pid;
    if ((pid = find_proc_by_name("clientogl.exe", 0)) != 0) return pid;
    if ((pid = find_proc_by_name("clientxna.exe", 0)) != 0) return pid;
    return 0;
}

static int preflight(HANDLE h)
{
    IMAGE_DOS_HEADER dos;
    IMAGE_NT_HEADERS32 nt;
    SIZE_T got;
    DWORD base = 0;
    HMODULE mods[8]; DWORD need = 0;
    if (!EnumProcessModules(h, mods, sizeof(mods), &need) || need < sizeof(HMODULE)) return 0;
    base = (DWORD)(ULONG_PTR)mods[0];
    if (!ReadProcessMemory(h, (LPCVOID)(ULONG_PTR)base, &dos, sizeof(dos), &got)) return 0;
    if (dos.e_magic != 0x5A4D) return 0;
    if (!ReadProcessMemory(h, (LPCVOID)(ULONG_PTR)(base + dos.e_lfanew), &nt, sizeof(nt), &got)) return 0;
    if (nt.Signature != 0x00004550) return 0;
    return (nt.FileHeader.Machine == EXPECT_MACHINE && nt.FileHeader.TimeDateStamp == EXPECT_TIMEDATE);
}

/* 打开目标进程时统一申请的权限。
   SYNCHRONIZE 是 WaitForSingleObject 的硬前提：v6.6 少了它，
   WaitForSingleObject 恒返回 WAIT_FAILED(ERROR_ACCESS_DENIED=5)，
   "游戏退出"永远检测不到，g_proc 永不释放 → 第二局不重挂（2026-10-23 实测症状）。 */
#define PROC_ACCESS (PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | SYNCHRONIZE)

/* 进程是否还活着。
   主路径是 handle 等待；WAIT_FAILED 时退回 GetExitCodeProcess，
   后者只需要 QUERY_INFORMATION，万一 SYNCHRONIZE 被组策略剥掉也不至于卡死。 */
static int proc_alive(HANDLE h)
{
    DWORD r;
    if (!h) return 0;
    r = WaitForSingleObject(h, 0);
    if (r == WAIT_OBJECT_0) return 0;
    if (r == WAIT_TIMEOUT) return 1;
    {
        DWORD code = 0;
        if (GetExitCodeProcess(h, &code)) return (code == STILL_ACTIVE) ? 1 : 0;
    }
    return 1;   /* 两种判据都拿不到就不擅自杀连接，留给下一轮 */
}

/* ---- Esc / 选项菜单探测（v7.0/R22）----
 * 只读 User32 的窗口树，不碰游戏内存：数游戏进程下可见的 #32770 类窗口。
 * 引擎的选项/退出确认是 CreateDialogParamA / CreateDialogIndirectParamA 建的
 * Win32 对话框（RT_DIALOG 模板 115/148/163，控件标签 STT:IGMultiOpt*,
 * STT:IGGameOpt*），默认类名就是 #32770。模板样式带 WS_CHILD(0x40000000)，
 * 所以既可能挂在游戏顶层窗口下，也可能自己就是顶层窗口——两条都查。 */
struct dlg_scan {
    DWORD pid;
    int   count;
};

static BOOL CALLBACK dlg_scan_proc(HWND h, LPARAM lp)
{
    struct dlg_scan *sc = (struct dlg_scan *)lp;
    DWORD pid = 0;
    char cls[32];

    GetWindowThreadProcessId(h, &pid);
    if (pid != sc->pid) return TRUE;
    if (!IsWindowVisible(h)) return TRUE;
    cls[0] = 0;
    if (!GetClassNameA(h, cls, sizeof(cls))) return TRUE;
    if (!strcmp(cls, "#32770")) sc->count++;
    return TRUE;
}

/* 顶层命中后把整棵子树也过一遍：WS_CHILD 的对话框不在顶层枚举里。
   注意 EnumChildWindows(NULL, ...) 语义等同 EnumWindows，会重复计数，
   所以必须逐个顶层窗口传句柄下去。 */
static BOOL CALLBACK dlg_root_proc(HWND h, LPARAM lp)
{
    struct dlg_scan *sc = (struct dlg_scan *)lp;
    DWORD pid = 0;

    GetWindowThreadProcessId(h, &pid);
    if (pid != sc->pid) return TRUE;
    dlg_scan_proc(h, lp);
    EnumChildWindows(h, dlg_scan_proc, lp);
    return TRUE;
}

/* 返回可见 #32770 的数量（0=无菜单）。失败一律返回 0，宁可漏判不误判。 */
static int count_game_dialogs(DWORD pid)
{
    struct dlg_scan sc;
    if (!pid) return 0;
    sc.pid = pid;
    sc.count = 0;
    EnumWindows(dlg_root_proc, (LPARAM)&sc);
    return sc.count;
}

/* ------------------------------------------------------------------ */
/* 数据模型                                                            */
/* ------------------------------------------------------------------ */
struct SuperRec {
    DWORD owner;
    char  id[48];
    int   pct;
    int   ready;
    int   suspended;
    int   total;
    int   left;
};

struct UnitTypeRec {
    char  id[32];      /* TechnoTypeClass ID（形态已归一到主形态，如 DEVOD -> DEVO） */
    int   count;
    int   hp, maxhp;   /* 聚合当前血量 / 理论满血（count*Strength） */
    int   veterancy;   /* 老兵度样本：0=新兵 1=老兵 2=精英（取最大值） */
};

/* 生产队列通道：与引擎的 6 个主工厂槽一一对应。
   顺序必须与 g_chan_defs 一致，渲染端按 key 取值。 */
enum { CH_BUILDING = 0, CH_DEFENSE, CH_INFANTRY, CH_VEHICLE, CH_NAVY, CH_AIRCRAFT, CH_COUNT };

struct QueueItemRec {
    char  id[32];
    int   pct;            /* 0..100，由 Progress/54 换算 */
    int   suspended;
};

struct QueueRec {
    int   active;         /* 0 = 该通道没有工厂（渲染端画"空闲"），1 = 有数据 */
    struct QueueItemRec now;                 /* 正在生产的那一单 */
    int   nnext;
    struct QueueItemRec next[16];            /* 排队中 */
};

struct PlayerRec {
    DWORD ptr;
    int   index;
    char  name[96];
    char  uiname[96];
    char  faction[32];
    char  country[32];
    int   side;
    int   ai_diff;
    BYTE  rgb[3];
    DWORD allies;
    int   team;
    int   human, in_ctrl;
    int   is_observer_house;                  /* v6/D1：观察者房（house==A_OBSERVER），渲染端应剔除 */
    int   win, lose, defeated, gameover, resigned, gaveup, lostconn;
    int   spied, thieved;
    int   inf_side0, inf_side1, inf_side2;    /* 渗透敌方阵营：解锁对应偷科技条目 */
    int   inf_barracks, inf_warfactory;       /* 渗透过敌方兵营/重工：己方新造单位直接老兵 */
    int   cash, spent, harvested, stolen, storage;
    int   power_out, power_drain, power_surplus;
    int   army_inf, army_veh, army_air;
    int   owned_units, owned_navy, owned_buildings, owned_infantry, owned_aircraft;
    int   kills_units, kills_buildings, lost_units, lost_buildings, points;
    int   base_pct, base_cx, base_cy;
    int   has_centroid, cent_x, cent_y, cent_bld;
    int   spawn_pos;
    int   last_hurt;
    int   nsupers;
    struct SuperRec supers[MAX_SUPERS];
    int   nunit_types;                      /* 单位构成（非建筑），按数量排序 */
    struct UnitTypeRec unit_types[MAX_UNITTYPES];
    struct QueueRec queues[CH_COUNT];       /* 生产队列（v6.6），按主工厂槽归属 */
};

/* 桥的守护状态机（v6.6）。渲染端用它区分"桥死了"和"还没开局"：
   no_client  客户端没开
   lobby      客户端在跑，游戏进程还没起（大厅/选图）
   loading    游戏进程起了，但 house 数组还没填（过图/读档中）
   match      house 有效，正常出数据（ok=true）
   post_match 刚检测到游戏退出，写一帧收尾，随后转 lobby/no_client */
#define PH_NO_CLIENT   0
#define PH_LOBBY       1
#define PH_LOADING     2
#define PH_MATCH       3
#define PH_POST_MATCH  4

static const char *phase_name(int p)
{
    switch (p) {
    case PH_NO_CLIENT:  return "no_client";
    case PH_LOBBY:      return "lobby";
    case PH_LOADING:    return "loading";
    case PH_MATCH:      return "match";
    case PH_POST_MATCH: return "post_match";
    }
    return "unknown";
}

struct Snap {
    int   ok;
    int   phase;                              /* v6.6：见 PH_*，桥的守护状态机 */
    int   client_running;                     /* v6.6：MO 客户端（clientdx/ogl/xna）是否在跑 */
    DWORD frame;
    int   game_mode, mpmax, mplayer_count;
    int   out_of_sync;
    int   elapsed_sec, paused;
    /* v7.0/R22：Esc/选项菜单。menu_open=两条信号的或；两个原始值同时输出，
       真机时用它判断到底哪条在起作用（都恒 0 说明这个界面两者都不是）。 */
    int   menu_open, menu_dialogs, menu_od;
    char  map_name[128], map_uiname[64], map_file[260], session_file[260];
    int   money, speed, ai_players, ai_diff, bases, bridges, crates, shortgame, allies;
    int   is_observer, observer_mode;
    int   view_x, view_y, view_zoom_x1000, view_cell_x, view_cell_y;
    int   map_rect[4], world_rect[4], valid_cells;
    /* v6.3 屏幕布局（像素；游戏渲染坐标系，含侧栏） */
    int   screen_valid;
    int   screen_w, screen_h;
    int   cfg_w, cfg_h, shell_w, shell_h;
    int   windowed, sidebar_side;
    int   view_rect[4];       /* DSurface::ViewBounds */
    int   sidebar_rect[4];    /* DSurface::SidebarBounds */
    int   window_rect[4];     /* DSurface::WindowBounds */
    int   sidebar_surface[2]; /* DSurface::Sidebar -> Width/Height */
    int   radar_rect[4], radar_view_rect[4], radar_scale_x1000;
    int   nhouses;
    int   uagg_dropped;                       /* 聚合表触顶丢弃的类型数（0=正常） */
    int   uagg_skipped;                       /* v6.9/R16：子机+载荷占位体被剔除的对象数 */
    struct PlayerRec players[MAX_HOUSES];
    int   nnode;
    char  node_names[8][64];
};

/* 基地质心 */
static DWORD g_cent_owner[MAX_HOUSES];
static long long g_cent_sx[MAX_HOUSES], g_cent_sy[MAX_HOUSES];
static int g_cent_n[MAX_HOUSES];
static int g_cent_cnt;

static void compute_centers(DWORD *houses, DWORD n)
{
    DWORD items = 0, count = 0, i, k;
    g_cent_cnt = (int)((n < MAX_HOUSES) ? n : MAX_HOUSES);
    for (k = 0; k < (DWORD)g_cent_cnt; ++k) {
        g_cent_owner[k] = houses[k];
        g_cent_sx[k] = g_cent_sy[k] = 0; g_cent_n[k] = 0;
    }
    if (!rd_u32(A_BUILDING_ARRAY_ITEMS, &items) || !items) return;
    if (!rd_u32(A_BUILDING_ARRAY_COUNT, &count) || count == 0 || count > 8192) return;
    for (i = 0; i < count; ++i) {
        DWORD op = 0, owner = 0;
        BYTE alive = 0, limbo = 0;
        int x = 0, y = 0;
        if (!rd_u32(items + i * 4, &op) || !op) continue;
        rd_u8(op + O_IS_ALIVE, &alive);
        rd_u8(op + O_IN_LIMBO, &limbo);
        if (!alive || limbo) continue;
        rd_u32(op + O_OWNER, &owner);
        for (k = 0; k < (DWORD)g_cent_cnt; ++k) {
            if (g_cent_owner[k] != owner) continue;
            rd_i32(op + O_LOCATION + 0, &x);
            rd_i32(op + O_LOCATION + 4, &y);
            g_cent_sx[k] += x; g_cent_sy[k] += y; g_cent_n[k]++;
            break;
        }
    }
}

static int house_center(DWORD hp, int *cx, int *cy, int *nb)
{
    int k;
    for (k = 0; k < g_cent_cnt; ++k) {
        if (g_cent_owner[k] != hp) continue;
        if (g_cent_n[k] <= 0) return 0;
        *cx = (int)(g_cent_sx[k] / g_cent_n[k] - 128) / 256;
        *cy = (int)(g_cent_sy[k] / g_cent_n[k] - 128) / 256;
        *nb = g_cent_n[k];
        return 1;
    }
    return 0;
}

/* ------------------------------------------------------------------ */
/* 单位构成（非建筑）：聚合到 (owner,type) 粒度，与 probe 的 UNIT COMPOSITION 同源。
 * 形态切换（Convert.Deploy，如 DEVO<->DEVOD）在引擎层 = 销毁旧单位+建新单位，
 * 读到的 TechnoType ID 自然是新形态，无需额外形态位。                              */
/* ------------------------------------------------------------------ */
struct UnitAgg {
    DWORD owner, type;
    char  id[32];      /* TechnoTypeClass ID（排序次级键 & 归一后形态判断用） */
    int   count, hp, vet;
};

static struct UnitAgg g_uagg[2048];
static int            g_uagg_n;
static int            g_uagg_dropped;   /* 聚合表触顶被丢弃的新类型数（顶层 uagg_dropped） */
static int            g_uagg_skipped;   /* v6.9/R16：被类型层闸剔除的对象数（顶层 uagg_skipped） */

/* ---- 载荷占位体（v6.9/R16）：Image=FAKEP 的 InitialPayload 假单位。
 * 它们不是玩家真正拥有的作战单位，混进 unit_types 会让火蜥蜴之类显示成"1 + 4 条"。
 * 刻意不收录：DRACOD（飞蜥炮台，能打能选）、MAGNET（超武投放可见实体）、
 * SLAV（Slave Worker，DontScore 但默认可选）。*/
static const char *g_dummy[] = {
    "SALA_1", "SALA_2",     /* 火蜥蜴 SALA 的 4 个混淆载荷 */
    "SUNB_1",               /* 猎日者 SUNB */
    "MAGNET_1", "MAGNET_2", /* 磁力束 MAGNET / 鹦鹉螺 NAUT */
    "CYCL_1",               /* 旋风 CYCL */
    "F_KSNAK",              /* 巨蟒折跃 F_KSNAK */
};
#define DUMMY_N (sizeof(g_dummy) / sizeof(g_dummy[0]))

static int is_dummy_id(const char *id)
{
    int i;
    for (i = 0; i < (int)DUMMY_N; ++i) {
        if (!strcmp(id, g_dummy[i])) return 1;
    }
    return 0;
}

/* ---- 形态归一（v6/D5）：Convert.Deploy 形态对 -> 主形态 ID。全部列出部署形态，
 * 引擎会销毁旧单位+建新形态单位，故按新形态 ID 查表即可归一。规则（用户裁决）：
 * 永远显示原单位（主形态）的图标与计数。                                  */
static const struct { const char *deployed; const char *main; } g_morph[] = {
    { "AERO2", "AERO" },     { "AHVYBOT2B", "AHVYBOT2" },
    { "ARCH2", "ARCH" },     { "BASS2", "BASS" },
    { "BURA2", "BURA" },     { "CHRTNK2", "CHRTNK" },
    { "DEVOD", "DEVO" },     { "DRON2", "DRON" },
    { "ETNK2", "ETNK" },     { "ROADR2", "ROADR" },
    { "SHADOWF", "SHADOW" }, { "SIREN2", "SIREN" },
    { "SUB2", "SUB" },       { "TRIKE2", "TRIKE" },
};
#define MORPH_N (sizeof(g_morph) / sizeof(g_morph[0]))

static void morph_normalize(char *id, int idn)
{
    int i;
    for (i = 0; i < (int)MORPH_N; ++i) {
        if (!strcmp(id, g_morph[i].deployed)) {
            lstrcpynA(id, g_morph[i].main, idn);
            return;
        }
    }
}

static void uagg_add(DWORD owner, DWORD type, const char *id, int hp, int vet)
{
    int i;
    for (i = 0; i < g_uagg_n; ++i) {
        if (g_uagg[i].owner == owner && g_uagg[i].type == type) {
            g_uagg[i].count++;
            g_uagg[i].hp += hp;
            if (vet > g_uagg[i].vet) g_uagg[i].vet = vet;
            return;
        }
    }
    if (g_uagg_n < 2048) {
        g_uagg[i].owner = owner; g_uagg[i].type = type;
        lstrcpynA(g_uagg[i].id, id, sizeof(g_uagg[i].id));
        g_uagg[i].count = 1; g_uagg[i].hp = hp;
        g_uagg[i].vet = vet;
        g_uagg_n++;
    } else {
        g_uagg_dropped++;
    }
}

static void unit_scan_array(DWORD array_addr, DWORD type_off, DWORD *houses, DWORD nhouses)
{
    DWORD items = 0, count = 0, i, k;
    if (!rd_u32(array_addr + V_ITEMS, &items) || !items) return;
    if (!rd_u32(array_addr + V_COUNT, &count) || count == 0 || count > 8192) return;
    for (i = 0; i < count; ++i) {
        DWORD op = 0, owner = 0, type = 0, carrier = 0;
        BYTE alive = 0, limbo = 0;
        int hp = 0, vet = 0;
        float fvet = 0.0f;
        int in_houses = 0;
        char id[32];
        if (!rd_u32(items + i * 4, &op) || !op) continue;
        rd_u8(op + O_IS_ALIVE, &alive);
        rd_u8(op + O_IN_LIMBO, &limbo);
        if (!alive) continue;
        if (limbo) {                            /* R15：载具乘员计回统计 */
            rd_u32(op + O_TRANSPORTER, &carrier);
            if (!carrier) continue;             /* 工厂排队/待部署等其余 limbo 仍剔除 */
        }
        rd_u32(op + O_OWNER, &owner);
        for (k = 0; k < nhouses; ++k) if (houses[k] == owner) { in_houses = 1; break; }
        if (!in_houses) continue;
        rd_u32(op + type_off, &type);
        if (!type) continue;
        /* v6.9/R16 闸①：Spawned 型（母舰/鸟巢/导弹释放的子机）不计。
           Spawned 声明在 TechnoTypeClass 基类里，Unit/Infantry/Aircraft 三个
           子类共用同一偏移，故对三张表统一生效。 */
        {
            BYTE spawned = 0;
            if (rd_u8(type + TY_SPAWNED, &spawned) && spawned) { g_uagg_skipped++; continue; }
        }
        id[0] = 0;
        rd_str(type + T_ID, id, sizeof(id));
        if (!id[0]) continue;
        /* v6.9/R16 闸②：Image=FAKEP 的载荷占位体不计（火蜥蜴等的 InitialPayload 假单位）。 */
        if (is_dummy_id(id)) { g_uagg_skipped++; continue; }
        morph_normalize(id, sizeof(id));        /* v6/D5：DEVOD -> DEVO 等形态归一 */
        /* v6.5：先读 hp / 老兵度，再做聚合。原先这两行在读之前就 merged/continue，
           导致第二个及以后的同型单位只加了 count，hp 与 vet 恒为 0——
           实测 4165 个多单位样本里 4130 个 hp 恰好等于单个单位的满血。 */
        rd_i32(op + O_HEALTH, &hp);
        rd_f32(op + O_VETERANCY, &fvet);        /* v6.5：+0x150 是 float，不是 double */
        vet = (fvet >= 1.5f) ? 2 : ((fvet >= 0.5f) ? 1 : 0);   /* 2=精英 1=老兵 0=新兵 */
        /* 归一后与同主形态聚合（type 指针不同的两形态会开两条目，按 id 再并一次） */
        {
            int merged = 0, j;
            for (j = 0; j < g_uagg_n; ++j) {
                if (g_uagg[j].owner == owner && !strcmp(g_uagg[j].id, id)) {
                    g_uagg[j].count++;
                    g_uagg[j].hp += hp;
                    if (vet > g_uagg[j].vet) g_uagg[j].vet = vet;
                    merged = 1;
                    break;
                }
            }
            if (merged) continue;
        }
        uagg_add(owner, type, id, hp, vet);
    }
}

static int uagg_cmp(const void *a, const void *b)
{
    const struct UnitAgg *x = (const struct UnitAgg *)a, *y = (const struct UnitAgg *)b;
    if (x->count != y->count) return y->count - x->count;   /* 数量降序 */
    return strcmp(x->id, y->id);                            /* v6/D4：同数量按 ID 字典序，稳定 */
}

/* 采集每玩家的单位构成（非建筑），写入 PlayerRec.unit_types */
static void collect_unit_types(DWORD *houses, DWORD count, struct Snap *s)
{
    int i, j;
    g_uagg_n = 0;
    g_uagg_dropped = 0;
    g_uagg_skipped = 0;
    unit_scan_array(A_UNIT_ARRAY,     UT_TYPE, houses, count);
    unit_scan_array(A_INFANTRY_ARRAY, IT_TYPE, houses, count);
    unit_scan_array(A_AIRCRAFT_ARRAY, UT_TYPE, houses, count);
    qsort(g_uagg, g_uagg_n, sizeof(struct UnitAgg), uagg_cmp);

    for (i = 0; i < s->nhouses; ++i) {
        struct PlayerRec *p = &s->players[i];
        p->nunit_types = 0;
        if (!p->ptr) continue;
        for (j = 0; j < g_uagg_n && p->nunit_types < MAX_UNITTYPES; ++j) {
            struct UnitTypeRec *u;
            int maxhp = 0;
            if (g_uagg[j].owner != p->ptr) continue;
            rd_i32(g_uagg[j].type + TY_STRENGTH, &maxhp);
            u = &p->unit_types[p->nunit_types++];
            memset(u, 0, sizeof(*u));
            lstrcpynA(u->id, g_uagg[j].id, sizeof(u->id));
            u->count  = g_uagg[j].count;
            u->hp     = g_uagg[j].hp;
            u->maxhp  = g_uagg[j].count * (maxhp > 0 ? maxhp : 1);
            u->veterancy = g_uagg[j].vet;
        }
    }
}

/* 超武：全局扫描，只保留 IsPresent=1 */
static int collect_supers(DWORD frame, struct SuperRec *out, int maxn)
{
    DWORD items = 0, count = 0, i;
    int n = 0;
    static unsigned char blk[0x90];
    if (!rd_u32(A_SUPER_ARRAY + V_ITEMS, &items) || !items) return 0;
    if (!rd_u32(A_SUPER_ARRAY + V_COUNT, &count) || count == 0 || count > 4096) return 0;
    for (i = 0; i < count && n < maxn; ++i) {
        DWORD sp = 0, stype = 0, owner = 0;
        int custom = -1, total = 0, start = 0, left = 0, pct = 0;
        int present = 0, ready = 0, susp = 0;
        if (!rd_u32(items + i * 4, &sp) || !sp) continue;
        if (!rd(sp, blk, sizeof(blk))) continue;
        present = *(unsigned char *)(blk + S_IS_PRESENT);
        if (!present) continue;
        owner = *(DWORD *)(blk + S_OWNER);
        if (!owner) continue;
        stype = *(DWORD *)(blk + S_TYPE);
        custom = *(int *)(blk + S_CUSTOM_CHARGE);
        start = *(int *)(blk + S_RECHARGE_TIMER + 0);
        left = *(int *)(blk + S_RECHARGE_TIMER + 8);
        ready = *(unsigned char *)(blk + S_IS_READY);
        susp = *(unsigned char *)(blk + S_IS_SUSPENDED);
        if (custom > 0) total = custom;
        else if (stype) rd_i32(stype + SWT_RECHARGE_TIME, &total);
        if (ready) pct = 100;
        else if (total > 0) {
            int rem = left;
            if (start != -1) { rem = left - ((int)frame - start); if (rem < 0) rem = 0; }
            pct = (int)(100.0 * (double)(total - rem) / (double)total);
            if (pct < 0) pct = 0;
            if (pct > 100) pct = 100;
        }
        out[n].owner = owner;
        out[n].id[0] = 0;
        if (stype) rd_str(stype + T_ID, out[n].id, sizeof(out[n].id));
        if (!out[n].id[0]) strcpy(out[n].id, "?");
        out[n].pct = pct;
        out[n].ready = ready;
        out[n].suspended = susp;
        out[n].total = total;
        out[n].left = left;
        n++;
    }
    return n;
}

/* ------------------------------------------------------------------ */
/* 采集                                                                */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------ 队列采集 */

/* 对象 → TechnoTypeClass*。Type 的偏移随子类不同（+0x6C4 / +0x6C0 / +0x520），
   所以先读对象首 DWORD 的 vtable 再分派；匹配不到就返回 0，绝不按单一偏移硬读。
   vtable 地址与各子类 GetType 实现均已用 IDA 核验：
     UnitClass     vt 0x7F5C70  GetType@0x741490 = [ecx+6C4h]
     AircraftClass vt 0x7E22A4  GetType@0x41C200 = [ecx+6C4h]
     InfantryClass vt 0x7EB058  GetType@0x51FAF0 = [ecx+6C0h]
     BuildingClass vt 0x7E3EBC  GetType@0x459EE0 = [ecx+520h] */
static DWORD type_of_object(DWORD obj)
{
    DWORD vt = 0, type = 0;
    if (!rd_u32(obj, &vt) || !vt) return 0;
    if (vt == VT_UNIT_CLASS || vt == VT_AIRCRAFT_CLASS)      rd_u32(obj + UT_TYPE, &type);
    else if (vt == VT_INFANTRY_CLASS)                        rd_u32(obj + IT_TYPE, &type);
    else if (vt == VT_BUILDING_CLASS)                        rd_u32(obj + BT_TYPE, &type);
    return type;
}

/* 类型对象 → ID（形态归一，与 unit_types 同口径）。rd_str 无返回值，先读再判空。 */
static int id_of_type(DWORD type, char *id, int idn)
{
    id[0] = 0;
    if (!type) return 0;
    rd_str(type + T_ID, id, idn);
    if (!id[0]) return 0;
    morph_normalize(id, idn);
    return 1;
}

/* 队列归属：读 house 的 6 个主工厂指针，与全局工厂数组里的 Owner 指针比对。
   通道 → 主工厂槽的映射取自 GetPrimaryFactory@0x500510 的分派表：
     case 1/40 (Unit/UnitType) → naval ? 0x53B8 : 0x53B4
     case 2/3 (Aircraft*)      → 0x53AC
     case 15/16 (Infantry*)    → 0x53B0
     case 6/7 (Building*)      → BuildCat==5 ? 0x53CC : 0x53BC
   这里不需要 BuildCat：槽位本身就是"建筑/防御"两条通道的区分依据。 */
static const struct { int slot_off; const char *key; } g_chan_defs[CH_COUNT] = {
    { H_PRIMARY_BUILDINGS, "building" },
    { H_PRIMARY_DEFENSES,  "defense"  },
    { H_PRIMARY_INFANTRY,  "infantry" },
    { H_PRIMARY_VEHICLES,  "vehicle"  },
    { H_PRIMARY_SHIPS,     "navy"     },
    { H_PRIMARY_AIRCRAFT,  "aircraft" }
};

/* 把一个 FactoryClass* 的当前生产状态读进 qr。
   active=1 但 now.id 为空 = 该通道有厂但没在产，渲染端画"空闲"。 */
static void read_one_factory(DWORD fp, struct QueueRec *qr)
{
    DWORD obj = 0, qitems = 0;
    int progress = 0, qcount = 0, k;
    BYTE suspended = 0;
    char id[32];

    qr->active = 1;

    rd_i32(fp + F_PROGRESS, &progress);
    rd_u8 (fp + F_IS_SUSPENDED, &suspended);
    if (!rd_u32(fp + F_OBJECT, &obj) || !obj) return;

    {
        DWORD type = type_of_object(obj);
        if (id_of_type(type, id, sizeof(id))) {
            strncpy(qr->now.id, id, sizeof(qr->now.id) - 1);
            qr->now.pct = (progress > 0) ? (progress * 100 / PROGRESS_DONE) : 0;
            if (qr->now.pct > 100) qr->now.pct = 100;
            qr->now.suspended = suspended ? 1 : 0;
        }
    }

    /* 排队项：QueuedObjects 里就是 TechnoTypeClass* */
    if (rd_u32(fp + F_QUEUE_ITEMS, &qitems) && qitems &&
        rd_i32(fp + F_QUEUE_COUNT, &qcount) && qcount > 0 && qcount <= 256) {
        for (k = 0; k < qcount && qr->nnext < (int)(sizeof(qr->next) / sizeof(qr->next[0])); ++k) {
            DWORD tp = 0;
            if (!rd_u32(qitems + k * 4, &tp) || !tp) continue;
            if (!id_of_type(tp, id, sizeof(id))) continue;
            strncpy(qr->next[qr->nnext].id, id, sizeof(qr->next[qr->nnext].id) - 1);
            qr->next[qr->nnext].pct = 0;
            qr->nnext++;
        }
    }
}

/* 生产队列采集。主路径是直接读 house 的 6 个主工厂槽——
   这条路径不依赖 FactoryClass::Array 是否注册、也不依赖 Owner 反查，
   只要 GetPrimaryFactory 的槽位语义没变就能出数据。
   全局工厂数组只作为补充：槽位为空时（部分 AI/并行工厂不填槽）再从数组里找。 */
static void collect_queues(DWORD *houses, DWORD nhouses, struct Snap *s)
{
    DWORD items = 0, count = 0, i, hi;
    int ch;

    for (hi = 0; hi < nhouses && hi < MAX_HOUSES; ++hi)
        memset(&s->players[hi].queues, 0, sizeof(s->players[hi].queues));

    /* ---- 主路径：house 主工厂槽 ---- */
    for (hi = 0; hi < nhouses && hi < MAX_HOUSES; ++hi) {
        DWORD hp = houses[hi];
        struct PlayerRec *pr;
        if (!hp) continue;
        pr = &s->players[hi];
        if (!pr->ptr) continue;
        for (ch = 0; ch < CH_COUNT; ++ch) {
            DWORD slot = 0;
            if (!rd_u32(hp + g_chan_defs[ch].slot_off, &slot) || !slot) continue;
            read_one_factory(slot, &pr->queues[ch]);
        }
    }

    /* ---- 补充路径：全局工厂数组里挂到主槽的工厂 ----
       只处理槽位还没填上的通道，避免覆盖主路径的结果。 */
    if (!rd_u32(A_FACTORY_ITEMS, &items) || !items) return;
    if (!rd_u32(A_FACTORY_COUNT, &count) || count == 0 || count > 4096) return;

    for (i = 0; i < count; ++i) {
        DWORD fp = 0, owner = 0;
        struct PlayerRec *pr = NULL;

        if (!rd_u32(items + i * 4, &fp) || !fp) continue;
        if (!rd_u32(fp + F_OWNER, &owner) || !owner) continue;

        for (hi = 0; hi < nhouses && hi < MAX_HOUSES; ++hi)
            if (houses[hi] == owner) { pr = &s->players[hi]; break; }
        if (!pr || !pr->ptr) continue;

        for (ch = 0; ch < CH_COUNT; ++ch) {
            DWORD slot = 0;
            if (!rd_u32(owner + g_chan_defs[ch].slot_off, &slot)) continue;
            if (slot != fp) continue;
            if (!pr->queues[ch].active) read_one_factory(fp, &pr->queues[ch]);
            break;
        }
    }
}

/* ------------------------------------------------------------------ */
/* 队列运行时诊断（--diag-queues）                                      */
/* ------------------------------------------------------------------ */
/* 队列为空的可能断点有六处，逐环打印，一次就能看出断在哪：
     1 house 数组没读到 / count 异常
     2 house 的 6 个主工厂槽全为 0（AI 房/观察者房常见）
     3 工厂数组 A83E30 的 Items/Count 读不到
     4 工厂的 Owner(+0x6C) 为 0 或不在 house[] 里
     5 工厂指针不等于该 Owner 的任一主工厂槽（归属失配）
     6 主工厂槽对上但 Object 为 0 / 类型解析失败
   只读，不写 hud_state.json，可与守护桥同时跑。 */
/* 前向声明：诊断模式最后要用正式采集器做交叉验证。 */
static void collect(struct Snap *s, int max_supers_per_player);

static const char *vt_class_name(DWORD vt){
    switch (vt) {
    case VT_UNIT_CLASS:      return "UnitClass";
    case VT_AIRCRAFT_CLASS:  return "AircraftClass";
    case VT_INFANTRY_CLASS:  return "InfantryClass";
    case VT_BUILDING_CLASS:  return "BuildingClass";
    case VT_UNIT_TYPE_CLASS:     return "UnitTypeClass";
    case VT_INFANTRY_TYPE_CLASS: return "InfantryTypeClass";
    case VT_BUILDING_TYPE_CLASS: return "BuildingTypeClass";
    case VT_AIRCRAFT_TYPE_CLASS: return "AircraftTypeClass";
    }
    return "?";
}

static int diag_queues(int seconds)
{
    DWORD his = 0, hcount = 0, fitems = 0, fcount = 0;
    DWORD houses[MAX_HOUSES];
    int round = 0;
    for (;;) {
        int hi, fi;
        DWORD frame = 0;
        int slot_set = 0, factory_matched = 0, orphan = 0, unreadable = 0;

        printf("\n================ diag round %d ================\n", ++round);
        rd_u32(A_CURRENT_FRAME, &frame);
        printf("frame          : %lu\n", (unsigned long)frame);

        /* ---- 1. house 数组 ---- */
        if (!rd_u32(A_HOUSE_ITEMS, &his) || !his) { printf("[FAIL] house.Items 读不到\n"); goto tail; }
        if (!rd_u32(A_HOUSE_COUNT, &hcount) || !hcount || hcount > MAX_HOUSES) {
            printf("[FAIL] house.Count=%lu 异常（0 或 >%d）\n", (unsigned long)hcount, MAX_HOUSES);
            goto tail;
        }
        printf("house array    : items=0x%08lX count=%lu\n",
               (unsigned long)his, (unsigned long)hcount);

        for (hi = 0; hi < (int)hcount; ++hi) {
            char nm[96]; char faction[32];
            DWORD hp = 0, type = 0;
            houses[hi] = 0;
            rd_u32(his + hi * 4, &houses[hi]);
            hp = houses[hi];
            if (!hp) { printf("  house[%-2d] = NULL\n", hi); continue; }
            nm[0] = 0; faction[0] = 0;
            rd_str(hp + H_PLAIN_NAME, nm, sizeof(nm));
            rd_u32(hp + H_TYPE, &type);
            if (type) rd_str(type + T_ID, faction, sizeof(faction));
            printf("  house[%-2d] 0x%08lX  name=%-16s faction=%-8s  slots:",
                   hi, (unsigned long)hp, nm[0] ? nm : "?", faction[0] ? faction : "?");
            {
                int k;
                for (k = 0; k < CH_COUNT; ++k) {
                    DWORD slot = 0;
                    rd_u32(hp + g_chan_defs[k].slot_off, &slot);
                    printf(" %s=%s", g_chan_defs[k].key, slot ? "set" : "-");
                    if (slot) {
                        printf("(0x%08lX)", (unsigned long)slot);
                        slot_set++;
                    }
                }
            }
            printf("\n");
        }

        /* ---- 2/3. 工厂数组 ---- */
        /* 两个候选向量：0xA83E30 是 FactoryClass::Array（构造函数 sub_4E6E60 写入），
           0xB0F720 是同一构造器里的第二个向量。若前者 count=0 而后者有内容，
           说明我们读的不是实际在用的那个 —— 这正是"其他字段全对、只有队列空"的形状。 */
        {
            DWORD alt_items = 0, alt_count = 0;
            rd_u32(0x00B0F724u, &alt_items);
            rd_u32(0x00B0F730u, &alt_count);
            printf("alt vector     : 0xB0F720 items=0x%08lX count=%lu\n",
                   (unsigned long)alt_items, (unsigned long)alt_count);
        }
        if (!rd_u32(A_FACTORY_ITEMS, &fitems) || !fitems) {
            printf("[FAIL] Factory.Items 读不到（A83E30+4）\n"); goto tail;
        }
        if (!rd_u32(A_FACTORY_COUNT, &fcount)) { printf("[FAIL] Factory.Count 读不到\n"); goto tail; }
        printf("factory array  : items=0x%08lX count=%lu\n",
               (unsigned long)fitems, (unsigned long)fcount);
        if (fcount == 0) { printf("[FAIL] factory 数组为空：本局还没有任何工厂\n"); goto tail; }
        if (fcount > 4096) { printf("[FAIL] factory.Count=%lu 异常\n", (unsigned long)fcount); goto tail; }

        for (fi = 0; fi < (int)fcount; ++fi) {
            DWORD fp = 0, owner = 0, obj = 0, qitems = 0, vt = 0, type = 0;
            int progress = 0, qcount = 0, owner_hi = -1, chan = -1, k;
            BYTE susp = 0;
            char oid[32];

            if (!rd_u32(fitems + fi * 4, &fp) || !fp) { printf("  factory[%-2d] NULL/unreadable\n", fi); unreadable++; continue; }
            if (!rd_u32(fp + F_OWNER, &owner)) { printf("  factory[%-2d] 0x%08lX  [FAIL] Owner 读不到\n", fi, (unsigned long)fp); unreadable++; continue; }

            for (k = 0; k < (int)hcount; ++k) if (houses[k] == owner) { owner_hi = k; break; }
            for (k = 0; k < CH_COUNT; ++k) {
                DWORD slot = 0;
                if (owner && rd_u32(owner + g_chan_defs[k].slot_off, &slot) && slot == fp) { chan = k; break; }
            }
            if (chan >= 0) factory_matched++;
            if (!owner) orphan++;

            rd_i32(fp + F_PROGRESS, &progress);
            rd_u8 (fp + F_IS_SUSPENDED, &susp);
            rd_u32(fp + F_OBJECT, &obj);
            rd_u32(fp + F_QUEUE_ITEMS, &qitems);
            rd_i32(fp + F_QUEUE_COUNT, &qcount);

            printf("  factory[%-2d] 0x%08lX  owner=0x%08lX (%s)  chan=%-8s  p=%d/%d susp=%d\n",
                   fi, (unsigned long)fp, (unsigned long)owner,
                   owner ? (owner_hi >= 0 ? "in house[]" : "NOT IN HOUSE ARRAY") : "NULL",
                   chan >= 0 ? g_chan_defs[chan].key : "UNMATCHED",
                   progress, PROGRESS_DONE, susp);

            /* Object 的类型解析链 */
            oid[0] = 0;
            if (obj) {
                rd_u32(obj, &vt);
                type = type_of_object(obj);
                if (!id_of_type(type, oid, sizeof(oid)))
                    printf("      object 0x%08lX vt=0x%08lX(%s) type=0x%08lX -> [FAIL] id 读不到\n",
                           (unsigned long)obj, (unsigned long)vt, vt_class_name(vt),
                           (unsigned long)type);
                else
                    printf("      object 0x%08lX vt=0x%08lX(%s) type=0x%08lX id=%s\n",
                           (unsigned long)obj, (unsigned long)vt, vt_class_name(vt),
                           (unsigned long)type, oid);
            } else {
                printf("      object = NULL（该通道当前没有在产单位）\n");
            }
            /* 排队项 */
            if (qitems && qcount > 0) {
                int j, shown = 0;
                printf("      queued: count=%d items=0x%08lX ->", qcount, (unsigned long)qitems);
                for (j = 0; j < qcount && shown < 8; ++j) {
                    DWORD tp = 0; char tid[32]; DWORD tvt = 0;
                    if (!rd_u32(qitems + j * 4, &tp) || !tp) { printf(" [null]"); continue; }
                    rd_u32(tp, &tvt);
                    if (id_of_type(tp, tid, sizeof(tid))) printf(" %s", tid);
                    else printf(" [type 0x%08lX vt=%s id?]", (unsigned long)tp, vt_class_name(tvt));
                    shown++;
                }
                printf("\n");
            } else if (qitems) {
                printf("      queued: items=0x%08lX count=0（队列空）\n", (unsigned long)qitems);
            }
        }

        printf("-- summary: house主槽非零=%d  工厂数=%lu  工厂挂上主槽=%d  Owner为空=%d  不可读=%d\n",
               slot_set, (unsigned long)fcount, factory_matched, orphan, unreadable);
        if (slot_set == 0)
            printf("-- 判定：所有 house 的 6 个主工厂槽都是 0 → 本局没建厂/仍是过图阶段\n");
        else if (factory_matched == 0)
            printf("-- 判定：主槽有指针但工厂数组里找不到同一个指针 → Owner 归属失配（重点看上面 UNMATCHED 行）\n");

        /* ---- 交叉验证：用正式采集器跑一遍，看它实际产出什么 ----
           上面是逐环原始值，这里是 collect_queues() 的最终结果。
           两者对照就能判断问题出在"内存里就没有"还是"采集器没认出来"。 */
        {
            static struct Snap chk;   /* 665 KB，必须静态 */
            int pi, qi, any = 0;
            g_fail = 0;
            collect(&chk, 8);
            printf("-- collect(): ok=%d frame=%lu houses=%d g_fail=%d\n",
                   chk.ok, (unsigned long)chk.frame, chk.nhouses, g_fail);
            for (pi = 0; pi < chk.nhouses; ++pi) {
                const struct PlayerRec *pp = &chk.players[pi];
                if (!pp->ptr) continue;
                printf("   player[%d] %-16s :", pi, pp->name[0] ? pp->name : "?");
                for (qi = 0; qi < CH_COUNT; ++qi) {
                    const struct QueueRec *qq = &pp->queues[qi];
                    if (!qq->active) continue;
                    printf(" %s=%s/%d%%(+%d)", g_chan_defs[qi].key,
                           qq->now.id[0] ? qq->now.id : "idle", qq->now.pct, qq->nnext);
                    any = 1;
                }
                printf("\n");
            }
            if (!any) printf("   （collect() 没有输出任何 active 通道）\n");
        }

tail:
        fflush(stdout);   /* 每轮刷一次；否则管道/重定向下要等缓冲区满才可见 */
        if (round >= seconds) break;
        Sleep(1000);
    }
    return 0;
}

static void collect(struct Snap *s, int max_supers_per_player)
{
    DWORD items = 0, count = 0, cur = 0, obs = 0, frame = 0, scen = 0;
    DWORD houses[MAX_HOUSES];
    DWORD i, j;
    static struct SuperRec allsupers[2048];
    int nsupers;
    memset(s, 0, sizeof(*s));

    if (!rd_u32(A_HOUSE_ITEMS, &items) || !rd_u32(A_HOUSE_COUNT, &count) ||
        count == 0 || count > MAX_HOUSES) {
        s->ok = 0;
        return;
    }
    s->ok = 1;

    rd_u32(A_CURRENT_FRAME, &frame);
    s->frame = frame;
    rd_u32(A_CURRENT_PLAYER, &cur);
    rd_u32(A_OBSERVER, &obs);

    /* session */
    rd_i32(A_SESSION + SE_GAMEMODE, &s->game_mode);
    rd_i32(A_SESSION + SE_MPLAYER_MAX, &s->mpmax);
    rd_i32(A_SESSION + SE_MPLAYER_COUNT, &s->mplayer_count);
    {
        BYTE oos = 0;
        rd_u8(A_SESSION + SE_OUT_OF_SYNC, &oos);
        s->out_of_sync = oos;
    }
    rd_str(A_SESSION + SE_SCENARIO_FILENAME, s->session_file, sizeof(s->session_file));

    /* scenario */
    if (rd_u32(A_SCENARIO, &scen) && scen) {
        int start = -1, left = 0, now_ticks = (int)(timeGetTime() >> 4);
        int ticks;
        BYTE paused = 0;
        rd_i32(scen + SC_ELAPSED_TIMER + 0, &start);
        rd_i32(scen + SC_ELAPSED_TIMER + 8, &left);
        rd_u8 (scen + SC_IS_PAUSED, &paused);
        rd_wstr(scen + SC_NAME, s->map_name, sizeof(s->map_name));
        rd_str(scen + SC_UINAME, s->map_uiname, sizeof(s->map_uiname));
        rd_str(scen + SC_FILENAME, s->map_file, sizeof(s->map_file));
        ticks = (start == -1) ? left : left + (now_ticks - start);
        if (ticks < 0) ticks = 0;
        s->elapsed_sec = ticks * 16 / 1000;
        s->paused = (start == -1) ? 1 : 0;
        if (!s->paused && paused) s->paused = 1;
    }

    /* v7.0/R22：Esc/选项菜单。两条独立信号，任一成立即视为菜单开着。
       ① Win32 对话框：枚举游戏进程的窗口树找可见 #32770（纯 User32 查询）。
       ② OwnerDraw 对话框栈深度：1..4 才采信，越界当脏数据。 */
    {
        int od = 0;
        DWORD gpid = g_proc ? GetProcessId(g_proc) : 0;
        s->menu_dialogs = count_game_dialogs(gpid);
        if (rd_i32(A_OWNERDRAW_DLG_DEPTH, &od) && od > 0 && od <= 4) {
            s->menu_od = od;
        }
        s->menu_open = (s->menu_dialogs > 0 || s->menu_od > 0) ? 1 : 0;
    }

    /* options */
    rd_i32(A_GAMEMODE_OPTIONS + GO_MONEY, &s->money);
    rd_i32(A_GAMEMODE_OPTIONS + GO_GAMESPEED, &s->speed);
    rd_i32(A_GAMEMODE_OPTIONS + 0x0024, &s->ai_players);
    rd_i32(A_GAMEMODE_OPTIONS + 0x0028, &s->ai_diff);
    {
        BYTE b = 0;
        rd_u8(A_GAMEMODE_OPTIONS + GO_BASES, &b);     s->bases = b;
        rd_u8(A_GAMEMODE_OPTIONS + GO_BRIDGES, &b);   s->bridges = b;
        rd_u8(A_GAMEMODE_OPTIONS + GO_CRATES, &b);    s->crates = b;
        rd_u8(A_GAMEMODE_OPTIONS + GO_SHORTGAME, &b); s->shortgame = b;
        rd_u8(A_GAMEMODE_OPTIONS + GO_ALLIES, &b);    s->allies = b;
    }

    /* 观战标志 */
    {
        BYTE om = 0;
        rd_u8(A_OBSERVER_MODE, &om);
        s->observer_mode = om;
        s->is_observer = (cur && obs && cur == obs) ? 1 : 0;
    }

    /* 相机 */
    {
        DWORD tac = 0;
        if (rd_u32(A_TACTICAL, &tac) && tac) {
            int tx = 0, ty = 0, mx = 0, my = 0, mw = 0, mh = 0;
            double zoom = 0.0;
            rd_i32(tac + TC_TACTICAL_POS + 0, &tx);
            rd_i32(tac + TC_TACTICAL_POS + 4, &ty);
            rd(tac + TC_ZOOM, &zoom, sizeof(zoom));
            rd_i32(tac + TC_MAP_COORDS + 0, &mx);
            rd_i32(tac + TC_MAP_COORDS + 4, &my);
            rd_i32(tac + TC_MAP_COORDS + 8, &mw);
            rd_i32(tac + TC_MAP_COORDS + 12, &mh);
            s->view_x = tx; s->view_y = ty;
            s->view_zoom_x1000 = (int)(zoom * 1000.0 + 0.5);
            s->map_rect[0] = mx; s->map_rect[1] = my;
            s->map_rect[2] = mw; s->map_rect[3] = mh;
            /* 屏幕像素 -> 格：px = 15*(cx-cy), py = 15*(cx+cy) */
            s->view_cell_x = (int)((tx / 30.0 + ty / 15.0) / 2.0);
            s->view_cell_y = (int)((ty / 15.0 - tx / 30.0) / 2.0);
        }
    }
    {
        int rx = 0, ry = 0, rw = 0, rh = 0, vc = 0;
        if (rd_i32(A_MAP_INSTANCE + MAP_RECT + 0, &rx) &&
            rd_i32(A_MAP_INSTANCE + MAP_RECT + 4, &ry) &&
            rd_i32(A_MAP_INSTANCE + MAP_RECT + 8, &rw) &&
            rd_i32(A_MAP_INSTANCE + MAP_RECT + 12, &rh)) {
            rd_i32(A_MAP_INSTANCE + MAP_VALID_CELLS, &vc);
            s->world_rect[0] = rx; s->world_rect[1] = ry;
            s->world_rect[2] = rw; s->world_rect[3] = rh;
            s->valid_cells = vc;
        }
    }

    /* 屏幕布局（v6.3）：全部是渲染像素；读失败不影响其余字段，screen_valid=0 */
    {
        DWORD primary = 0, sidebar = 0;
        BYTE  win = 0, smode = 0;
        float rscale = 0.0f;

        s->screen_valid = 1;

        if (rd_u32(A_PRIMARY_SURFACE, &primary) && primary) {
            if (!rd_i32(primary + SURF_WIDTH,  &s->screen_w)) s->screen_valid = 0;
            if (!rd_i32(primary + SURF_HEIGHT, &s->screen_h)) s->screen_valid = 0;
        } else {
            s->screen_valid = 0;
        }
        if (rd_u32(A_SIDEBAR_SURFACE, &sidebar) && sidebar) {
            rd_i32(sidebar + SURF_WIDTH,  &s->sidebar_surface[0]);
            rd_i32(sidebar + SURF_HEIGHT, &s->sidebar_surface[1]);
        }

        rd_i32(A_GAME_OPTIONS + GO_SCREEN_W, &s->cfg_w);
        rd_i32(A_GAME_OPTIONS + GO_SCREEN_H, &s->cfg_h);
        rd_i32(A_GAME_OPTIONS + GO_SHELL_W,  &s->shell_w);
        rd_i32(A_GAME_OPTIONS + GO_SHELL_H,  &s->shell_h);
        rd_u8 (A_GAME_OPTIONS + GO_SIDEBAR_MODE, &smode);
        s->sidebar_side = smode;
        rd_u8 (A_WINDOWED_MODE, &win);
        s->windowed = win;

        if (!rd_rect(A_DSURF_VIEW_BOUNDS, s->view_rect))       s->screen_valid = 0;
        if (!rd_rect(A_SIDEBAR_BOUNDS,    s->sidebar_rect))    s->screen_valid = 0;
        rd_rect(A_WINDOW_BOUNDS, s->window_rect);              /* 可选，失败不算致命 */

        rd_rect(A_MAP_INSTANCE + R_RADAR_RECT,      s->radar_rect);
        rd_rect(A_MAP_INSTANCE + R_RADAR_VIEW_RECT, s->radar_view_rect);
        if (rd_f32(A_MAP_INSTANCE + R_RADAR_SCALE, &rscale))
            s->radar_scale_x1000 = (int)(rscale * 1000.0f + 0.5f);
    }

    /* 玩家名单 */
    for (i = 0; i < count; ++i) {
        houses[i] = 0;
        rd_u32(items + i * 4, &houses[i]);
    }
    compute_centers(houses, count);    nsupers = collect_supers(frame, allsupers, 2048);

    for (i = 0; i < count; ++i) {
        struct PlayerRec *p = &s->players[i];
        DWORD hp = houses[i], type = 0;
        int idx = 0, side = 0, aidiff = 0, team = 0, ip = 0;
        int bal = 0, spent = 0, harvest = 0, stolen = 0, storage = 0;
        int pout = 0, pdrain = 0, psurplus = 0;
        int infc = 0, vehc = 0, airc = 0, wholast = -1;
        int kuh[20], kbh[20];
        int k;
        char tmp[256], u8[256];

        if (!hp) { p->ptr = 0; continue; }
        p->ptr = hp;

        rd_i32(hp + H_INDEX, &idx); p->index = idx;
        rd_i32(hp + H_SIDE_INDEX, &side); p->side = side;
        rd_i32(hp + H_AI_DIFFICULTY, &aidiff); p->ai_diff = aidiff;
        rd_u32(hp + H_TYPE, &type);
        if (type) {
            rd_str(type + T_ID, tmp, sizeof(tmp));
            to_utf8_ansi(tmp, p->faction, sizeof(p->faction));
            rd_str(type + T_PARENT_COUNTRY, tmp, sizeof(tmp));
            to_utf8_ansi(tmp, p->country, sizeof(p->country));
        }
        rd_str(hp + H_PLAIN_NAME, tmp, sizeof(tmp));
        to_utf8_ansi(tmp, p->name, sizeof(p->name));
        rd_wstr(hp + H_UINAME, p->uiname, sizeof(p->uiname));   /* UTF-16 -> UTF-8 */
        /* v6/D1：PlainName 可能是引擎占位符 "<human player>"，此时取 UIName 真实昵称 */
        if ((!p->name[0] || !strcmp(p->name, "<human player>")) && p->uiname[0])
            strcpy(p->name, p->uiname);

        rd(hp + H_COLOR, p->rgb, 3);
        rd_u32(hp + H_ALLIES, &p->allies);
        rd_i32(hp + H_TEAM_ID, &team); p->team = team;
        rd_i32(hp + H_IP, &ip); (void)ip;

        rd_u8(hp + H_IS_HUMAN, (BYTE *)&p->human);
        rd_u8(hp + H_IS_IN_CTRL, (BYTE *)&p->in_ctrl);
        rd_u8(hp + H_DEFEATED, (BYTE *)&p->defeated);
        rd_u8(hp + H_IS_GAMEOVER, (BYTE *)&p->gameover);
        rd_u8(hp + H_IS_WINNER, (BYTE *)&p->win);
        rd_u8(hp + H_IS_LOSER, (BYTE *)&p->lose);
        rd_u8(hp + H_IS_RESIGNER, (BYTE *)&p->resigned);
        rd_u8(hp + H_IS_GIVERUPPER, (BYTE *)&p->gaveup);
        rd_u8(hp + H_LOST_CONNECTION, (BYTE *)&p->lostconn);
        rd_u8(hp + H_HAS_BEEN_SPIED, (BYTE *)&p->spied);
        rd_u8(hp + H_HAS_BEEN_THIEVED, (BYTE *)&p->thieved);
        rd_u8(hp + H_SIDE0_TECH_INFILTRATED, (BYTE *)&p->inf_side0);
        rd_u8(hp + H_SIDE1_TECH_INFILTRATED, (BYTE *)&p->inf_side1);
        rd_u8(hp + H_SIDE2_TECH_INFILTRATED, (BYTE *)&p->inf_side2);
        rd_u8(hp + H_BARRACKS_INFILTRATED, (BYTE *)&p->inf_barracks);
        rd_u8(hp + H_WAR_FACTORY_INFILTRATED, (BYTE *)&p->inf_warfactory);

        rd_i32(hp + H_BALANCE, &bal);           p->cash = bal;
        rd_i32(hp + H_CREDITS_SPENT, &spent);   p->spent = spent;
        rd_i32(hp + H_HARVESTED, &harvest);     p->harvested = harvest;
        rd_i32(hp + H_STOLEN_CREDITS, &stolen); p->stolen = stolen;
        rd_i32(hp + H_TOTAL_STORAGE, &storage); p->storage = storage;
        rd_i32(hp + H_POWER_OUT, &pout);
        rd_i32(hp + H_POWER_DRAIN, &pdrain);
        rd_i32(hp + H_POWER_SURPLUS, &psurplus);
        p->power_out = pout; p->power_drain = pdrain; p->power_surplus = psurplus;
        rd_i32(hp + H_TOTAL_INF_COST, &infc);
        rd_i32(hp + H_TOTAL_VEH_COST, &vehc);
        rd_i32(hp + H_TOTAL_AIR_COST, &airc);
        p->army_inf = infc; p->army_veh = vehc; p->army_air = airc;

        rd_i32(hp + H_OWNED_UNITS, &p->owned_units);
        rd_i32(hp + H_OWNED_NAVY, &p->owned_navy);
        rd_i32(hp + H_OWNED_BUILDINGS, &p->owned_buildings);
        rd_i32(hp + H_OWNED_INFANTRY, &p->owned_infantry);
        rd_i32(hp + H_OWNED_AIRCRAFT, &p->owned_aircraft);

        memset(kuh, 0, sizeof(kuh));
        memset(kbh, 0, sizeof(kbh));
        rd(hp + H_KILLS_OF_HOUSES, kuh, sizeof(kuh));
        rd(hp + H_KILLS_BLD_OF_HOUSES, kbh, sizeof(kbh));
        p->kills_units = 0; p->kills_buildings = 0;
        for (k = 0; k < 20; ++k) {
            if (kuh[k] > 0) p->kills_units += kuh[k];
            if (kbh[k] > 0) p->kills_buildings += kbh[k];
        }
        rd_i32(hp + H_LOST_UNITS, &p->lost_units);
        rd_i32(hp + H_LOST_BUILDINGS, &p->lost_buildings);
        rd_i32(hp + H_POINT_TOTAL, &p->points);
        rd_i32(hp + H_WHO_LAST_HURT_ME, &wholast); p->last_hurt = wholast;

        rd_i32(hp + H_BASE + B_PERCENT_BUILT, &p->base_pct);
        rd_i16(hp + H_BASE + B_CENTER + 0, &p->base_cx);
        rd_i16(hp + H_BASE + B_CENTER + 2, &p->base_cy);
        p->has_centroid = house_center(hp, &p->cent_x, &p->cent_y, &p->cent_bld);

        /* 出生点 */
        p->spawn_pos = -1;
        if (scen) {
            int hi = 0;
            for (k = 0; k < 8; ++k) {
                if (!rd_i32(scen + SC_HOUSE_INDICES + k * 4, &hi)) break;
                if (hi == idx) { p->spawn_pos = k; break; }
            }
        }

        /* v6/D1：观察者房判定（放在 spawn_pos 之后，用其做兜底判据） */
        p->is_observer_house = 0;
        if (obs && hp == obs) p->is_observer_house = 1;
        else if (cur && hp == cur && s->is_observer) p->is_observer_house = 1;
        /* v6.1：共享模式下 is_observer=0，不能拿 spawn=-1 判观察者房 */
        else if (s->is_observer && p->spawn_pos == -1 && p->human) p->is_observer_house = 1;

        /* 该玩家的超武 */
        p->nsupers = 0;
        for (k = 0; k < nsupers && p->nsupers < max_supers_per_player && p->nsupers < MAX_SUPERS; ++k) {
            if (allsupers[k].owner != hp) continue;
            p->supers[p->nsupers++] = allsupers[k];
        }
        (void)u8;
    }
    s->nhouses = (int)count;

    /* 单位构成（非建筑，按数量排序，图标由渲染端按 unit id 查 icons 目录） */
    collect_unit_types(houses, count, s);
    /* 两个计数都在 collect 之后取：该函数开头会把 g_uagg_dropped 清零再累加，
       原先在调用前赋值，读到的是上一帧的值。 */
    s->uagg_dropped = g_uagg_dropped;
    s->uagg_skipped = g_uagg_skipped;

    /* 生产队列（v6.6）：按主工厂槽归属到 6 条通道 */
    collect_queues(houses, count, s);

    /* NodeNames（真实昵称，宽字符） */
    {
        DWORD nitems = 0, ncount = 0;
        if (rd_u32(A_NODENAME_ARRAY + V_ITEMS, &nitems) && nitems &&
            rd_u32(A_NODENAME_ARRAY + V_COUNT, &ncount) && ncount > 0 && ncount <= 8) {
            DWORD k;
            s->nnode = (int)ncount;
            for (k = 0; k < ncount; ++k) {
                DWORD np = 0;
                wchar_t wname[32];
                char tmp[128];
                if (!rd_u32(nitems + k * 4, &np) || !np) continue;
                if (!rd(np + 0x00, wname, sizeof(wname))) continue;
                to_utf8_wide(wname, tmp, sizeof(tmp));
                strncpy(s->node_names[k], tmp, sizeof(s->node_names[k]) - 1);
            }
        }
    }
}

/* ------------------------------------------------------------------ */
/* 输出                                                                */
/* ------------------------------------------------------------------ */

/* v6.4：把多行 JSON 压成单行，追加进 JSONL。
   解决的问题：out\hud_state.json 被每帧原子覆盖，游戏退出时还会写一份 ok=false，
   一旦忘记中途拷贝，整局样本就全没了（2026-10-21 实测踩到）。
   --record 打开后每帧追加一行，退出后文件仍在。 */
static FILE *g_rec = NULL;

static void record_line(const struct Snap *s, DWORD pid, const char *json, size_t len)
{
    size_t i;
    (void)pid;
    if (!g_rec || !json) return;
    /* 守护模式下桥整天常驻：大厅/未开局的帧没有留档价值，
       只记 ok=true 的局内帧，否则 JSONL 会被每秒一行撑爆。 */
    if (!s->ok) return;
    fprintf(g_rec, "{\"tick\": %lu, \"state\": ", (unsigned long)GetTickCount());
    for (i = 0; i < len; ++i) {
        char c = json[i];
        fputc((c == '\n' || c == '\r') ? ' ' : c, g_rec);
    }
    fputs("}\n", g_rec);
    fflush(g_rec);
}

static void emit_json(SB *b, const struct Snap *s, DWORD pid)
{
    int i, k;
    sb_add(b, "{\n");
    sb_printf(b, "  \"schema\": 2,\n  \"pid\": %lu,\n  \"ts\": %lu,\n  \"ok\": %s,\n",
              (unsigned long)pid, (unsigned long)GetTickCount(), s->ok ? "true" : "false");
    /* v6.6：守护状态。phase 让渲染端区分"桥停了"与"客户端/对局还没起" */
    sb_printf(b, "  \"phase\": \"%s\",\n  \"client_running\": %s,\n",
              phase_name(s->phase), s->client_running ? "true" : "false");
    sb_printf(b, "  \"frame\": %lu,\n  \"elapsed_sec\": %d,\n  \"paused\": %s,\n",
              (unsigned long)s->frame, s->elapsed_sec, s->paused ? "true" : "false");
    /* v7.0/R22：Esc/选项菜单。dialogs/owner_draw 是两条独立信号的原值，
       都恒 0 就说明这个界面既不建 #32770 也不是 OwnerDraw 对话框栈，需重新定位。 */
    sb_printf(b, "  \"menu_open\": %s,\n  \"menu\": {\"dialogs\": %d, \"owner_draw\": %d},\n",
              s->menu_open ? "true" : "false", s->menu_dialogs, s->menu_od);
    sb_printf(b, "  \"game_mode\": %d,\n  \"players_in_session\": %d,\n  \"players_max\": %d,\n  \"out_of_sync\": %s,\n",
              s->game_mode, s->mplayer_count, s->mpmax, s->out_of_sync ? "true" : "false");
    sb_add(b, "  \"map\": "); sb_json(b, s->map_name); sb_add(b, ",\n");
    sb_add(b, "  \"map_uiname\": "); sb_json(b, s->map_uiname); sb_add(b, ",\n");
    sb_add(b, "  \"map_file\": "); sb_json(b, s->map_file); sb_add(b, ",\n");
    sb_add(b, "  \"session_file\": "); sb_json(b, s->session_file); sb_add(b, ",\n");
    sb_printf(b, "  \"options\": {\"money\": %d, \"speed\": %d, \"ai\": %d, \"ai_diff\": %d, "
                 "\"bases\": %d, \"bridges\": %d, \"crates\": %d, \"shortgame\": %d, \"allies\": %d},\n",
              s->money, s->speed, s->ai_players, s->ai_diff,
              s->bases, s->bridges, s->crates, s->shortgame, s->allies);
    sb_printf(b, "  \"observer\": {\"is_observer\": %s, \"observer_mode\": %d},\n",
              s->is_observer ? "true" : "false", s->observer_mode);
    /* v6/P2：聚合表触顶丢弃计数（0=正常） */
    sb_printf(b, "  \"uagg_dropped\": %d,\n", s->uagg_dropped);
    /* v6.9/R16：子机 + 载荷占位体剔除计数（0=本局无子机/占位体，非异常） */
    sb_printf(b, "  \"uagg_skipped\": %d,\n", s->uagg_skipped);
    sb_printf(b, "  \"view\": {\"x\": %d, \"y\": %d, \"zoom\": %.3f, \"cell\": [%d, %d], "
                 "\"map_rect\": [%d, %d, %d, %d], \"world_rect\": [%d, %d, %d, %d], \"valid_cells\": %d},\n",
              s->view_x, s->view_y, s->view_zoom_x1000 / 1000.0,
              s->view_cell_x, s->view_cell_y,
              s->map_rect[0], s->map_rect[1], s->map_rect[2], s->map_rect[3],
              s->world_rect[0], s->world_rect[1], s->world_rect[2], s->world_rect[3],
              s->valid_cells);

    /* v6.3：屏幕/侧栏/小地图像素矩形（游戏渲染坐标系，单位 px）。
       view 里的是地图格坐标，两者不能混用。 */
    sb_printf(b, "  \"screen\": {\"valid\": %s, \"width\": %d, \"height\": %d, "
                 "\"configured\": [%d, %d], \"shell\": [%d, %d], "
                 "\"windowed\": %s, \"sidebar_side\": %d, "
                 "\"view_rect\": [%d, %d, %d, %d], "
                 "\"sidebar_rect\": [%d, %d, %d, %d], "
                 "\"window_rect\": [%d, %d, %d, %d], "
                 "\"sidebar_surface\": [%d, %d], "
                 "\"radar_rect\": [%d, %d, %d, %d], "
                 "\"radar_view_rect\": [%d, %d, %d, %d], "
                 "\"radar_scale\": %.3f},\n",
              s->screen_valid ? "true" : "false", s->screen_w, s->screen_h,
              s->cfg_w, s->cfg_h, s->shell_w, s->shell_h,
              s->windowed ? "true" : "false", s->sidebar_side,
              s->view_rect[0], s->view_rect[1], s->view_rect[2], s->view_rect[3],
              s->sidebar_rect[0], s->sidebar_rect[1], s->sidebar_rect[2], s->sidebar_rect[3],
              s->window_rect[0], s->window_rect[1], s->window_rect[2], s->window_rect[3],
              s->sidebar_surface[0], s->sidebar_surface[1],
              s->radar_rect[0], s->radar_rect[1], s->radar_rect[2], s->radar_rect[3],
              s->radar_view_rect[0], s->radar_view_rect[1], s->radar_view_rect[2], s->radar_view_rect[3],
              s->radar_scale_x1000 / 1000.0);

    sb_add(b, "  \"node_names\": [");
    for (i = 0; i < s->nnode; ++i) {
        if (i) sb_add(b, ", ");
        sb_json(b, s->node_names[i]);
    }
    sb_add(b, "],\n");

    sb_add(b, "  \"players\": [\n");
    {
        int emitted = 0;
    for (i = 0; i < s->nhouses; ++i) {
        const struct PlayerRec *p = &s->players[i];
        if (!p->ptr) continue;
        /* v6/D1：过渡房统一从输出剔除（与 emit_text 同口径）；
           v6.1：只有共享模式才剔观察者房，空镜头观战保留 spawn=-1 的真人玩家 */
        /* [TEMP-OBS-GATE-OFF 2026-10-21] 测试期禁用观察者判断：非观察者也输出全量玩家。
           发布前删掉 #if 0 / #endif 即可恢复原行为。 */
#if 0
        if (p->is_observer_house && s->is_observer) continue;
#endif
        if (p->side < 0 && !p->human) continue;   /* Neutral / Special */
        if (emitted) sb_add(b, ",\n");
        emitted = 1;
        sb_add(b, "    {");
        sb_printf(b, "\"slot\": %d, \"index\": %d, ", i, p->index);
        sb_add(b, "\"name\": "); sb_json(b, p->name); sb_add(b, ", ");
        sb_add(b, "\"uiname\": "); sb_json(b, p->uiname); sb_add(b, ", ");
        sb_add(b, "\"faction\": "); sb_json(b, p->faction); sb_add(b, ", ");
        sb_add(b, "\"country\": "); sb_json(b, p->country); sb_add(b, ", ");
        sb_printf(b, "\"side\": %d, \"ai_diff\": %d, \"color\": [%d, %d, %d], ",
                  p->side, p->ai_diff, p->rgb[0], p->rgb[1], p->rgb[2]);
        sb_printf(b, "\"team\": %d, \"allies_mask\": %lu, ", p->team, (unsigned long)p->allies);
        sb_printf(b, "\"human\": %s, \"in_control\": %s, \"is_observer_house\": %s, ",
                  p->human ? "true" : "false", p->in_ctrl ? "true" : "false",
                  p->is_observer_house ? "true" : "false");
        sb_printf(b, "\"cash\": %d, \"spent\": %d, \"harvested\": %d, \"stolen\": %d, \"storage\": %d, ",
                  p->cash, p->spent, p->harvested, p->stolen, p->storage);
        sb_printf(b, "\"power\": [%d, %d, %d], \"army_value\": [%d, %d, %d], ",
                  p->power_out, p->power_drain, p->power_surplus,
                  p->army_inf, p->army_veh, p->army_air);
        sb_printf(b, "\"owned\": {\"units\": %d, \"navy\": %d, \"buildings\": %d, \"infantry\": %d, \"aircraft\": %d}, ",
                  p->owned_units, p->owned_navy, p->owned_buildings, p->owned_infantry, p->owned_aircraft);
        sb_printf(b, "\"kills\": %d, \"kills_units\": %d, \"kills_buildings\": %d, ",
                  p->kills_units + p->kills_buildings, p->kills_units, p->kills_buildings);
        /* 计分板 Lost = 损失单位 + 损失建筑（IDA 0x46DA70：*(this+5488) + *(this+5434)） */
        sb_printf(b, "\"lost\": %d, \"lost_units\": %d, \"lost_buildings\": %d, \"score\": %d, ",
                  p->lost_units + p->lost_buildings, p->lost_units, p->lost_buildings, p->points);
        sb_printf(b, "\"base\": {\"percent\": %d, \"center\": [%d, %d], \"centroid\": %s",
                  p->base_pct, p->base_cx, p->base_cy,
                  p->has_centroid ? "true" : "false");
        if (p->has_centroid)
            sb_printf(b, ", \"centroid_cell\": [%d, %d], \"centroid_buildings\": %d",
                      p->cent_x, p->cent_y, p->cent_bld);
        sb_add(b, "}, ");
        sb_printf(b, "\"spawn\": %d, \"last_hurt_by\": %d, ", p->spawn_pos, p->last_hurt);
        sb_printf(b, "\"flags\": {\"win\": %d, \"lose\": %d, \"defeated\": %d, \"gameover\": %d, "
                     "\"resigned\": %d, \"gaveup\": %d, \"lostconn\": %d, \"spied\": %d, \"thieved\": %d}, ",
                  p->win, p->lose, p->defeated, p->gameover,
                  p->resigned, p->gaveup, p->lostconn, p->spied, p->thieved);
        /* 渗透收益（v6.2）：inf_barracks/inf_warfactory 为真时，
           该玩家新造步兵/载具直接老兵，渲染端应换 AltCameo 图标 */
        sb_printf(b, "\"infiltration\": {\"side0\": %d, \"side1\": %d, \"side2\": %d, "
                     "\"barracks\": %d, \"war_factory\": %d}, ",
                  p->inf_side0, p->inf_side1, p->inf_side2,
                  p->inf_barracks, p->inf_warfactory);
        sb_add(b, "\"supers\": [");
        for (k = 0; k < p->nsupers; ++k) {
            if (k) sb_add(b, ", ");
            sb_add(b, "{\"id\": "); sb_json(b, p->supers[k].id);
            sb_printf(b, ", \"pct\": %d, \"ready\": %s, \"suspended\": %s, \"total\": %d, \"left\": %d}",
                      p->supers[k].pct,
                      p->supers[k].ready ? "true" : "false",
                      p->supers[k].suspended ? "true" : "false",
                      p->supers[k].total, p->supers[k].left);
        }
        sb_add(b, "], ");
        /* 生产队列（v6.6）：只输出 active 的通道；没有工厂的通道整个键省略，
           渲染端据此画"空闲"而不是"未接入"。 */
        sb_add(b, "\"queues\": {");
        {
            int qi, qn = 0;
            for (qi = 0; qi < CH_COUNT; ++qi) {
                const struct QueueRec *qr = &p->queues[qi];
                if (!qr->active) continue;
                if (qn++) sb_add(b, ", ");
                sb_add(b, "\""); sb_add(b, g_chan_defs[qi].key); sb_add(b, "\": {");
                sb_add(b, "\"id\": "); sb_json(b, qr->now.id);
                sb_printf(b, ", \"pct\": %d, \"suspended\": %s, \"next\": [",
                          qr->now.pct, qr->now.suspended ? "true" : "false");
                {
                    int j;
                    for (j = 0; j < qr->nnext; ++j) {
                        if (j) sb_add(b, ", ");
                        sb_json(b, qr->next[j].id);
                    }
                }
                sb_add(b, "]}");
            }
        }
        sb_add(b, "}, ");
        /* 单位构成（非建筑）：图标按 id 查 icons 目录（如 icons/HTNK.png；缺图标时渲染端显示文字） */
        sb_add(b, "\"unit_types\": [");
        for (k = 0; k < p->nunit_types; ++k) {
            if (k) sb_add(b, ", ");
            sb_add(b, "{\"id\": "); sb_json(b, p->unit_types[k].id);
            sb_printf(b, ", \"count\": %d, \"hp\": %d, \"maxhp\": %d, \"veterancy\": %d}",
                      p->unit_types[k].count, p->unit_types[k].hp,
                      p->unit_types[k].maxhp, p->unit_types[k].veterancy);
        }
        sb_add(b, "]}");   /* 单条玩家对象结束 */
    }
    if (emitted) sb_add(b, "\n");
    }
    sb_add(b, "  ]\n}\n");
}

/* 给 OBS 文本源用的纯文本（等宽字体好看） */
static void emit_text(SB *b, const struct Snap *s)
{
    int i, mm, ss;
    mm = s->elapsed_sec / 60;
    ss = s->elapsed_sec % 60;
    if (!s->ok) {
        sb_add(b, "MO 3.3.6  |  等待对局...\n");
        return;
    }
    sb_printf(b, "MO 3.3.6  |  %02d:%02d  |  %s%s\n",
              mm, ss,
              s->map_name[0] ? s->map_name : (s->session_file[0] ? s->session_file : "?"),
              s->paused ? "  [暂停]" : "");
    /* v6.3：屏幕布局一行摘要（截图对照用） */
    sb_printf(b, "SCREEN %dx%d cfg %dx%d  view[%d,%d,%d,%d]  sidebar[%d,%d,%d,%d]  smode %d%s\n",
              s->screen_w, s->screen_h, s->cfg_w, s->cfg_h,
              s->view_rect[0], s->view_rect[1], s->view_rect[2], s->view_rect[3],
              s->sidebar_rect[0], s->sidebar_rect[1], s->sidebar_rect[2], s->sidebar_rect[3],
              s->sidebar_side, s->screen_valid ? "" : "  [INVALID]");
    sb_add(b, "--------------------------------------------------\n");
    for (i = 0; i < s->nhouses; ++i) {
        const struct PlayerRec *p = &s->players[i];
        if (!p->ptr) continue;
        /* [TEMP-OBS-GATE-OFF 2026-10-21] 同 emit_json，发布前删掉 #if 0 / #endif */
#if 0
        if (p->is_observer_house && s->is_observer) continue; /* v6.1：仅空镜头观战剔观察者房 */
#endif
        if (p->side < 0 && !p->human) continue;   /* 跳过中立/特殊房 */
        sb_printf(b, "%-14s %-10s  $%-8d  PWR %d/%d  K %d  L %d  SC %d%s\n",
                  p->name[0] ? p->name : "?",
                  p->faction[0] ? p->faction : "?",
                  p->cash, p->power_out, p->power_drain,
                  p->kills_units + p->kills_buildings,
                  p->lost_units + p->lost_buildings, p->points,
                  p->lostconn ? "  [掉线]" : (p->gaveup ? "  [退出]" : (p->defeated ? "  [战败]" : "")));
    }
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */
static void make_dir_of(const char *path)
{
    char buf[MAX_PATH];
    char *p;
    if (!path) return;
    strncpy(buf, path, MAX_PATH - 1); buf[MAX_PATH - 1] = 0;
    p = strrchr(buf, '\\');
    if (!p) p = strrchr(buf, '/');
    if (!p) return;
    *p = 0;
    if (buf[0]) CreateDirectoryA(buf, NULL);
}

static int dry_run(const char *out, const char *text)
{    struct Snap s;
    SB jb, tb;
    memset(&s, 0, sizeof(s));
    s.ok = 1; s.frame = 12345; s.elapsed_sec = 197; s.game_mode = 3;
    s.phase = PH_MATCH; s.client_running = 1;
    s.mplayer_count = 2; s.mpmax = 8;
    strcpy(s.map_name, "示例地图");
    strcpy(s.session_file, "MO_Example.map");
    s.money = 10000; s.speed = 1; s.ai_players = 2; s.ai_diff = 1;
    s.bases = 1; s.bridges = 1; s.allies = 1;
    s.is_observer = 1; s.observer_mode = 1;
    s.uagg_dropped = 0;
    s.uagg_skipped = 0;
    s.menu_open = 0; s.menu_dialogs = 0; s.menu_od = 0;
    s.view_x = 1608; s.view_y = 1831; s.view_zoom_x1000 = 1000;
    s.view_cell_x = 87; s.view_cell_y = 34;
    s.map_rect[0] = 85; s.map_rect[1] = 34; s.map_rect[2] = 31; s.map_rect[3] = 73;
    s.world_rect[0] = 0; s.world_rect[1] = 0; s.world_rect[2] = 200; s.world_rect[3] = 200;
    s.valid_cells = 40000;
    /* v6.3 屏幕布局样例。数值按 2026-10-21 游戏 debug 日志实测反推：
       Resolution = 1600 X 900 / SidebarSurface 168x900 / Set_View_Dimensions(0,0,1432,868)
       → view.W = screen.W - 168，view.H = screen.H - 32；
       SidebarBounds = { view.Right, 158, 168, view.Y + view.H + 32 - 158 }
       158 = 雷达 110 高 + 标签行 48。
       下面按 1920x1080 等比填：view = {0,0,1752,1048}。 */
    s.screen_valid = 1;
    s.screen_w = 1920; s.screen_h = 1080;
    s.cfg_w = 1920; s.cfg_h = 1080; s.shell_w = 1920; s.shell_h = 1080;
    s.windowed = 0; s.sidebar_side = 1;
    s.view_rect[0] = 0; s.view_rect[1] = 0; s.view_rect[2] = 1752; s.view_rect[3] = 1048;
    s.sidebar_rect[0] = 1752; s.sidebar_rect[1] = 158; s.sidebar_rect[2] = 168; s.sidebar_rect[3] = 922;
    s.window_rect[0] = 0; s.window_rect[1] = 0; s.window_rect[2] = 1920; s.window_rect[3] = 1080;
    s.sidebar_surface[0] = 168; s.sidebar_surface[1] = 1080;
    /* v6.5：radar_* 是**侧栏局部坐标**（2026-10-22 1920×1080 实测原值） */
    s.radar_rect[0] = 18; s.radar_rect[1] = 49; s.radar_rect[2] = 135; s.radar_rect[3] = 108;
    s.radar_view_rect[0] = 18; s.radar_view_rect[1] = 68; s.radar_view_rect[2] = 71; s.radar_view_rect[3] = 84;
    s.radar_scale_x1000 = 1213;
    s.nnode = 2; strcpy(s.node_names[0], "玩家甲"); strcpy(s.node_names[1], "玩家乙");
    s.nhouses = 3;   /* 真人 + AI + 观察者房（观察者房应被输出过滤剔除） */
    s.players[0].ptr = 0x1000; s.players[0].index = 0;
    strcpy(s.players[0].name, "玩家甲"); strcpy(s.players[0].faction, "USSR");
    s.players[0].side = 1; s.players[0].human = 1; s.players[0].in_ctrl = 1;
    s.players[0].is_observer_house = 0;
    s.players[0].rgb[0] = 56; s.players[0].rgb[1] = 148; s.players[0].rgb[2] = 248;
    s.players[0].cash = 12345; s.players[0].power_out = 210; s.players[0].power_drain = 300;
    s.players[0].kills_units = 79; s.players[0].kills_buildings = 36;
    s.players[0].lost_units = 37; s.players[0].points = 81993;
    s.players[0].has_centroid = 1; s.players[0].cent_x = 126; s.players[0].cent_y = 33;
    s.players[0].cent_bld = 22; s.players[0].spawn_pos = 0;
    s.players[0].nsupers = 2;
    strcpy(s.players[0].supers[0].id, "IronCurtainSpecial");
    s.players[0].supers[0].pct = 64; s.players[0].supers[0].total = 6000; s.players[0].supers[0].left = 2160;
    strcpy(s.players[0].supers[1].id, "SpyPlaneSpecial");
    s.players[0].supers[1].pct = 100; s.players[0].supers[1].ready = 1;
    s.players[0].supers[1].total = 3600; s.players[0].supers[1].left = 0;
    s.players[0].nunit_types = 3;
    strcpy(s.players[0].unit_types[0].id, "HTNK");
    s.players[0].unit_types[0].count = 6; s.players[0].unit_types[0].hp = 2600; s.players[0].unit_types[0].maxhp = 3200; s.players[0].unit_types[0].veterancy = 1;
    strcpy(s.players[0].unit_types[1].id, "FLAKT");
    s.players[0].unit_types[1].count = 12; s.players[0].unit_types[1].hp = 900; s.players[0].unit_types[1].maxhp = 1440; s.players[0].unit_types[1].veterancy = 0;
    strcpy(s.players[0].unit_types[2].id, "DEVO");   /* 形态已归一：巨像部署形态 DEVOD 计入 DEVO */
    s.players[0].unit_types[2].count = 3; s.players[0].unit_types[2].hp = 1340; s.players[0].unit_types[2].maxhp = 2010; s.players[0].unit_types[2].veterancy = 2;
    /* v6.6 队列样例：建筑 63%、步兵 44%（带 2 项排队）、载具空闲（槽位已建） */
    s.players[0].queues[CH_BUILDING].active = 1;
    strcpy(s.players[0].queues[CH_BUILDING].now.id, "GAPILE");
    s.players[0].queues[CH_BUILDING].now.pct = 63;
    s.players[0].queues[CH_BUILDING].nnext = 1;
    strcpy(s.players[0].queues[CH_BUILDING].next[0].id, "GAWEAP");
    s.players[0].queues[CH_INFANTRY].active = 1;
    strcpy(s.players[0].queues[CH_INFANTRY].now.id, "SHK");
    s.players[0].queues[CH_INFANTRY].now.pct = 44;
    s.players[0].queues[CH_INFANTRY].nnext = 2;
    strcpy(s.players[0].queues[CH_INFANTRY].next[0].id, "DESO");
    strcpy(s.players[0].queues[CH_INFANTRY].next[1].id, "SHK");
    s.players[0].queues[CH_VEHICLE].active = 1;   /* 有工厂但在产为 null → 渲染"空闲" */
    s.players[1].ptr = 0x2000; s.players[1].index = 1;
    strcpy(s.players[1].name, "玩家乙"); strcpy(s.players[1].faction, "UnitedStates");
    s.players[1].side = 0; s.players[1].human = 1; s.players[1].in_ctrl = 1;
    s.players[1].is_observer_house = 0;
    s.players[1].rgb[0] = 248; s.players[1].rgb[1] = 56; s.players[1].rgb[2] = 56;
    s.players[1].cash = 9876; s.players[1].power_out = 150; s.players[1].power_drain = 120;
    s.players[1].kills_units = 41; s.players[1].kills_buildings = 12;
    s.players[1].lost_units = 60; s.players[1].points = 41200;
    s.players[1].has_centroid = 1; s.players[1].cent_x = 60; s.players[1].cent_y = 140;
    s.players[1].cent_bld = 18; s.players[1].spawn_pos = 1;
    s.players[1].defeated = 1;   /* 示例：战败标记 */
    s.players[1].inf_barracks = 1;   /* 示例：渗透过兵营 → 新造步兵直接老兵 */
    /* 观察者房样例（应被 JSON/文本双双剔除） */
    s.players[2].ptr = 0x3000; s.players[2].index = 5;
    strcpy(s.players[2].name, "<human player>"); strcpy(s.players[2].uiname, "观战者甲");
    s.players[2].side = 0; s.players[2].human = 1; s.players[2].is_observer_house = 1;
    s.players[2].defeated = 1; s.players[2].spawn_pos = -1;

    sb_init(&jb); sb_init(&tb);
    emit_json(&jb, &s, 0);
    emit_text(&tb, &s);
    make_dir_of(out); make_dir_of(text);
    if (!write_atomic(out, jb.p, jb.n)) { printf("write %s failed\n", out); return 1; }
    if (text && text[0] && !write_atomic(text, tb.p, tb.n)) { printf("write %s failed\n", text); return 1; }
    printf("dry-run ok -> %s , %s\n", out, text);
    sb_free(&jb); sb_free(&tb);
    return 0;
}

int main(int argc, char **argv)
{
    DWORD pid = 0;
    int interval = 500, max_supers = 8, i;
    char out[MAX_PATH] = "out\\hud_state.json";
    char text[MAX_PATH] = "out\\hud_text.txt";
    char record[MAX_PATH] = "";
    int do_text = 1;
    int is_dry = 0;
    int dump_screen = 0;
    int out_given = 0;
    int diag_queues_sec = 0;

    for (i = 1; i < argc; ++i) {
        if (!strcmp(argv[i], "--pid") && i + 1 < argc) pid = (DWORD)strtoul(argv[++i], NULL, 0);
        else if (!strcmp(argv[i], "--interval") && i + 1 < argc) interval = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--out") && i + 1 < argc) { strncpy(out, argv[++i], MAX_PATH - 1); out_given = 1; }
        else if (!strcmp(argv[i], "--text") && i + 1 < argc) strncpy(text, argv[++i], MAX_PATH - 1);
        else if (!strcmp(argv[i], "--no-text")) do_text = 0;
        else if (!strcmp(argv[i], "--supers") && i + 1 < argc) max_supers = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--dry-run")) is_dry = 1;
        else if (!strcmp(argv[i], "--dump-screen")) dump_screen = 1;
        else if (!strcmp(argv[i], "--diag-queues")) {
            diag_queues_sec = 1;
            if (i + 1 < argc && argv[i + 1][0] != '-') diag_queues_sec = atoi(argv[++i]);
            if (diag_queues_sec <= 0) diag_queues_sec = 1;
        }
        else if (!strcmp(argv[i], "--record") && i + 1 < argc) strncpy(record, argv[++i], MAX_PATH - 1);
        else if (!strcmp(argv[i], "--help")) {
            printf("hud_bridge.exe [--pid N] [--interval MS] [--out FILE] [--text FILE] "
                   "[--no-text] [--supers N] [--record FILE.jsonl] [--dry-run] [--dump-screen] "
                   "[--diag-queues [SEC]]\n");
            return 0;
        }
    }
    if (interval < 100) interval = 100;
    if (max_supers < 0) max_supers = 0;
    if (max_supers > MAX_SUPERS) max_supers = MAX_SUPERS;
    if (is_dry) {
        /* 没显式给 --out 时不要写真实的 out/hud_state.json：
           直接跑一次 --dry-run 就把直播数据替换成示例，很容易踩。 */
        if (!out_given) {
            strcpy(out, "out\\hud_dry.json");
            strcpy(text, "out\\hud_dry.txt");
        }
        return dry_run(out, do_text ? text : "");
    }

    make_dir_of(out);
    if (do_text) make_dir_of(text);

    /* --diag-queues：只读诊断，不写状态文件、不抢单实例互斥体，
       所以可以在守护桥跑着的时候另开一个窗口抓现场。
       支持"先开检查器、后开局"：没找到游戏时每 2 秒重试，最多等 10 分钟。 */
    if (diag_queues_sec > 0) {
        DWORD target = pid;
        int waited = 0;
        while (!target && waited < 600000) {
            target = find_gamemd();
            if (!target) {
                if (waited == 0) {
                    printf("等待 gamemd.exe（最多 10 分钟）... 开局后自动开始诊断\n");
                    fflush(stdout);   /* 重定向到文件/管道时是全缓冲，不刷会看着像卡死 */
                }
                Sleep(2000);
                waited += 2000;
            }
        }
        if (!target) {
            printf("gamemd.exe not found（等待超时）。请先开局，或用 --pid 指定。\n");
            return 1;
        }
        g_proc = OpenProcess(PROC_ACCESS, FALSE, target);
        if (!g_proc) {
            printf("OpenProcess(0x%08lX) failed, GetLastError=%lu (先确认权限/位数)\n",
                   (unsigned long)target, GetLastError());
            return 1;
        }
        if (!preflight(g_proc)) {
            printf("preflight failed: pid %lu 不是预期的 gamemd.exe 构建。\n",
                   (unsigned long)target);
            CloseHandle(g_proc);
            return 2;
        }
        printf("diag-queues: pid=%lu rounds=%d (每秒一轮，Ctrl+C 提前结束)\n",
               (unsigned long)target, diag_queues_sec);
        {
            int rc = diag_queues(diag_queues_sec);
            CloseHandle(g_proc);
            g_proc = NULL;
            return rc;
        }
    }

    /* v6.6：单实例。两个桥同时 MoveFileEx 同一个 JSON 会互相踩，
       而守护模式下迟早会有人双击两次。 */
    {
        HANDLE once = CreateMutexA(NULL, TRUE, "MO_HUD_BRIDGE_SINGLETON");
        if (once && GetLastError() == ERROR_ALREADY_EXISTS) {
            printf("another hud_bridge is already running; exiting.\n");
            CloseHandle(once);
            return 3;
        }
        /* once 故意不释放：进程退出时系统回收，生命周期恰好等于本进程 */
    }

    if (record[0]) {
        make_dir_of(record);
        g_rec = fopen(record, "ab");   /* 追加：同一天多局累积，不会互相覆盖 */
        if (!g_rec) printf("warning: cannot open record file %s\n", record);
        else printf("record -> %s (append)\n", record);
    }

    /* --dump-screen：与守护模式分开。有 pid 就立刻 dump 并退出（旧行为），
       没 pid 则短轮询等游戏起来（最多 ~30 秒），方便"先跑工具再开局"。 */
    if (dump_screen) {
        int waited = 0;
        if (!pid) {
            printf("waiting for gamemd.exe (up to 30s)...\n");
            while (!pid && waited < 30000) { Sleep(500); waited += 500; pid = find_gamemd(); }
        }
        if (!pid) { printf("gamemd.exe not found.\n"); return 1; }
        g_proc = OpenProcess(PROC_ACCESS, FALSE, pid);
        if (!g_proc) {
            printf("OpenProcess failed, GetLastError=%lu (run as admin?)\n", GetLastError());
            return 1;
        }
        if (!preflight(g_proc)) {
            printf("preflight failed: target is not the expected gamemd.exe build.\n");
            CloseHandle(g_proc);
            return 2;
        }
        {
            /* Snap 约 665 KB（64 个 PlayerRec × 10.4 KB）。放栈上会超默认 1 MB 栈，
               尤其 main 里有两处实例时必崩（实测 0xC00000FD）。 */
            static struct Snap s;
            collect(&s, max_supers);
            printf("screen.valid = %s\n", s.screen_valid ? "true" : "false");
            printf("  surface      : %dx%d\n", s.screen_w, s.screen_h);
            printf("  configured   : %dx%d   shell: %dx%d   windowed=%d\n",
                   s.cfg_w, s.cfg_h, s.shell_w, s.shell_h, s.windowed);
            printf("  sidebar_side : %d (%s)\n", s.sidebar_side, s.sidebar_side ? "right" : "left");
            printf("  view_rect    : [%d, %d, %d, %d]\n",
                   s.view_rect[0], s.view_rect[1], s.view_rect[2], s.view_rect[3]);
            printf("  sidebar_rect : [%d, %d, %d, %d]\n",
                   s.sidebar_rect[0], s.sidebar_rect[1], s.sidebar_rect[2], s.sidebar_rect[3]);
            printf("  window_rect  : [%d, %d, %d, %d]\n",
                   s.window_rect[0], s.window_rect[1], s.window_rect[2], s.window_rect[3]);
            printf("  sidebar_surf : %dx%d\n", s.sidebar_surface[0], s.sidebar_surface[1]);
            printf("  radar_rect   : [%d, %d, %d, %d]\n",
                   s.radar_rect[0], s.radar_rect[1], s.radar_rect[2], s.radar_rect[3]);
            printf("  radar_view   : [%d, %d, %d, %d]\n",
                   s.radar_view_rect[0], s.radar_view_rect[1], s.radar_view_rect[2], s.radar_view_rect[3]);
            printf("  frame        : %lu   (过图阶段 radar_view 尚未填，<60 帧的值不可信)\n",
                   (unsigned long)s.frame);
            printf("  radar_scale  : %.3f\n", s.radar_scale_x1000 / 1000.0);
            printf("  cross-check  : view.right=%d sidebar.x=%d  sidebar.x+w=%d surface.w=%d\n",
                   s.view_rect[0] + s.view_rect[2], s.sidebar_rect[0],
                   s.sidebar_rect[0] + s.sidebar_rect[2], s.screen_w);
            printf("  cross-check2 : view.h+32=%d surface.h=%d   sidebar.y+h=%d\n",
                   s.view_rect[3] + 32, s.screen_h,
                   s.sidebar_rect[1] + s.sidebar_rect[3]);
            /* 队列摘要：通道 → 在产 ID / 进度 / 后续条数 */
            {
                int qi, pi;
                for (pi = 0; pi < s.nhouses; ++pi) {
                    const struct PlayerRec *pp = &s.players[pi];
                    if (!pp->ptr) continue;
                    printf("  queues[%s] ", pp->name[0] ? pp->name : "?");
                    for (qi = 0; qi < CH_COUNT; ++qi) {
                        const struct QueueRec *qr = &pp->queues[qi];
                        if (!qr->active) continue;
                        printf("%s=%s/%d%%(+%d) ", g_chan_defs[qi].key,
                               qr->now.id[0] ? qr->now.id : "idle", qr->now.pct, qr->nnext);
                    }
                    printf("\n");
                }
            }
            {
                SB jb, tb;
                sb_init(&jb); sb_init(&tb);
                emit_json(&jb, &s, pid);
                emit_text(&tb, &s);
                write_atomic(out, jb.p, jb.n);
                if (do_text) write_atomic(text, tb.p, tb.n);
                printf("(full state also written to %s)\n", out);
                sb_free(&jb); sb_free(&tb);
            }
        }
        CloseHandle(g_proc);
        if (g_rec) { fclose(g_rec); g_rec = NULL; }
        return 0;
    }

    /* ---------------------------------------------------------------- 守护 */
    /* v6.6：桥常驻。游戏进程生灭（一局结束→回大厅→下一局）不再导致桥退出，
       也就不会再出现"第二局页面读到的永远是一份 ok:false 的静止文件"。
       用 handle 判活而不是 pid：pid 会被系统复用，handle 不会。 */
    printf("bridge: daemon interval=%dms out=%s text=%s\n",
           interval, out, do_text ? text : "-");

    {
        int phase = -1;            /* -1 = 还没打印过 */
        int client_seen = 0;
        int reopen_warned = 0;
        DWORD game_pid = pid;      /* --pid 指定的固定目标；0 = 自动发现 */

        for (;;) {
            static struct Snap s;   /* 665 KB，必须静态（见上） */
            SB jb, tb;
            int have_game = 0;

            if (!g_proc) {
                DWORD found = game_pid ? game_pid : find_gamemd();
                if (found) {
                    HANDLE h = OpenProcess(PROC_ACCESS, FALSE, found);
                    if (h && preflight(h)) {
                        g_proc = h;
                        game_pid = found;
                        g_fail = 0;
                    } else {
                        if (h) { CloseHandle(h); }
                        else if (!reopen_warned) {
                            printf("OpenProcess failed (GetLastError=%lu). "
                                   "If the game runs elevated, start the bridge as admin.\n",
                                   GetLastError());
                            reopen_warned = 1;
                        }
                        /* preflight 失败：可能抢在原版 YR 上，退避重试 */
                    }
                }
            }
            have_game = (g_proc != NULL);

            if (have_game) {
                if (!proc_alive(g_proc)) {
                    /* 游戏退出：写一帧 post_match，然后进入等待重挂 */
                    memset(&s, 0, sizeof(s));
                    s.phase = PH_POST_MATCH;
                    s.client_running = find_client() ? 1 : 0;
                    sb_init(&jb); sb_init(&tb);
                    emit_json(&jb, &s, game_pid);
                    emit_text(&tb, &s);
                    write_atomic(out, jb.p, jb.n);
                    if (do_text) write_atomic(text, tb.p, tb.n);
                    sb_free(&jb); sb_free(&tb);
                    /* JSONL 分隔行，事后切分多局样本靠它，不靠猜 ok 翻转 */
                    if (g_rec) {
                        fprintf(g_rec, "{\"tick\": %lu, \"event\": \"match_end\", \"pid\": %lu}\n",
                                (unsigned long)GetTickCount(), (unsigned long)game_pid);
                        fflush(g_rec);
                    }
                    printf("game exited (pid=%lu); waiting for next match.\n", (unsigned long)game_pid);
                    CloseHandle(g_proc);
                    g_proc = NULL;
                    game_pid = 0;
                    continue;
                }

                collect(&s, max_supers);
                if (!s.ok && s.frame == 0) s.phase = PH_LOADING;
                else s.phase = s.ok ? PH_MATCH : PH_LOADING;
            } else {
                DWORD cpid = find_client();
                client_seen = cpid ? 1 : 0;
                memset(&s, 0, sizeof(s));
                s.phase = cpid ? PH_LOBBY : PH_NO_CLIENT;
                s.client_running = client_seen;
            }

            if (s.phase != phase) {
                printf("phase -> %s%s\n", phase_name(s.phase),
                       s.phase == PH_MATCH ? "" : (s.client_running ? " (client running)" : ""));
                fflush(stdout);   /* 重定向到日志文件时 stdout 是全缓冲，不刷就看不到 */
                phase = s.phase;
            }

            sb_init(&jb); sb_init(&tb);
            emit_json(&jb, &s, game_pid);
            emit_text(&tb, &s);
            if (!write_atomic(out, jb.p, jb.n)) {
                /* 读端未共享删除权限时 MoveFileEx 会失败；静默漏帧在直播里看不出来 */
                static int wa_fail = 0;
                if (++wa_fail == 1 || (wa_fail % 100) == 0)
                    printf("warning: write %s failed (%d times)\n", out, wa_fail);
            }
            if (do_text && !write_atomic(text, tb.p, tb.n)) { /* 同上，文本源不关键 */ }
            record_line(&s, game_pid, jb.p, jb.n);
            sb_free(&jb); sb_free(&tb);

            /* 挂上了就按 interval 跑；没挂上放慢到 1s，别空转扫进程 */
            Sleep(g_proc ? interval : 1000);
        }
    }
}
