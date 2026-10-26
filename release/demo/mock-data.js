/* 演示数据：全部为模拟值，不对应任何真实对局。
   字段口径对齐 hud_state.json：
   - country：国家 HouseType ID，对应 rules.ini 的 File.Flag
   - power: [产出/上限, 消耗/已用]（bridge 的 power[0] / power[1]）
   - unit_types[]：id / count / hp / maxhp / veterancy（v6 已输出，按数量降序）
   - queues：生产队列，按引擎的 6 个主工厂槽组织（bridge 待输出）
       building 建筑 / defense 防御 / infantry 步兵 /
       vehicle 载具 / navy 海军 / aircraft 飞机
     每项 { id, pct, next:[...] }；不存在的通道视为空闲。
   - infiltration：兵营 / 重工是否被渗透（bridge v6.2 的
       infiltration.barracks / war_factory，对应 HouseClass +0x02BF / +0x02C0），
     为真时该玩家新造步兵 / 载具直接老兵，队列图标使用 AltCameo。
   - series：局分（比赛名左右两个整数） */
window.MOCK = {
  map: "MO · 铁幕之下",
  paused: false,
  elapsed: 742,
  series: { A: 1, B: 2 },
  teams: [
    {
      key: "A",
      name: "分队 A",
      players: [
        {
          name: "赤色黎明", country: "USSR", faction: "苏联", color: "#f83838",
          cash: 12450, power: [500, 420], army: 6900, kills: 115, lost: 37, score: 81993,
          infiltration: { barracks: 0, war_factory: 1 },
          queues: {
            building: { id: "GAPILE", pct: 62, next: ["GAWEAP"] },
            defense:  { id: "GAPILL", pct: 18, next: [] },
            infantry: { id: "SHK", pct: 44, next: ["DESO", "SHK", "DESO"] },
            vehicle:  { id: "HTNK", pct: 71, next: ["HTNK", "APOC"] },
            aircraft: { id: "ZEP", pct: 9, next: [] }
          },
          units: [
            { id: "HTNK", count: 6, hp: 2600, maxhp: 3200, vet: 1 },
            { id: "APOC", count: 2, hp: 1600, maxhp: 2000, vet: 2 },
            { id: "SHK", count: 4, hp: 420, maxhp: 500, vet: 0 },
            { id: "DESO", count: 3, hp: 300, maxhp: 360, vet: 1 },
            { id: "FLAKT", count: 5, hp: 900, maxhp: 1200, vet: 0 },
            { id: "ZEP", count: 2, hp: 1400, maxhp: 2000, vet: 1 },
            { id: "SMCV", count: 1, hp: 1000, maxhp: 1000, vet: 0 },
            { id: "YDOG", count: 6, hp: 180, maxhp: 240, vet: 0 }
          ]
        },
        {
          name: "北境之盾", country: "UnitedStates", faction: "盟军", color: "#3894f8",
          cash: 9870, power: [300, 340], army: 5400, kills: 88, lost: 52, score: 61240,
          infiltration: { barracks: 1, war_factory: 0 },
          queues: {
            building: { id: "GAPOWR", pct: 35, next: ["GATECH", "GAREFN"] },
            defense:  { id: "GAGUN", pct: 84, next: [] },
            infantry: { id: "E1", pct: 27, next: ["E1", "E1", "SPY"] },
            vehicle:  { id: "LTNK", pct: 53, next: [] },
            aircraft: { id: "HARP", pct: 12, next: ["HARP"] }
          },
          units: [
            { id: "LTNK", count: 5, hp: 1250, maxhp: 1500, vet: 1 },
            { id: "AEGIS", count: 3, hp: 750, maxhp: 900, vet: 0 },
            { id: "TANY", count: 1, hp: 500, maxhp: 500, vet: 2 },
            { id: "HARP", count: 4, hp: 300, maxhp: 400, vet: 1 },
            { id: "E1", count: 8, hp: 400, maxhp: 640, vet: 0 },
            { id: "E2", count: 4, hp: 320, maxhp: 400, vet: 0 },
            { id: "SPY", count: 2, hp: 150, maxhp: 200, vet: 0 },
            { id: "AMCV", count: 1, hp: 1000, maxhp: 1000, vet: 0 }
          ]
        },
        {
          name: "深蓝回响", country: "PsiCorps", faction: "厄普西隆", color: "#38f838",
          cash: 15230, power: [600, 380], army: 8100, kills: 142, lost: 29, score: 96420,
          infiltration: { barracks: 0, war_factory: 0 },
          queues: {
            building: { id: "YABRCK", pct: 88, next: [] },
            infantry: { id: "BRUTE", pct: 66, next: ["BRUTE", "MIND"] },
            vehicle:  { id: "DEVO", pct: 31, next: ["DEVO", "PCV"] },
            navy:     { id: "DEST", pct: 48, next: ["DEST", "SUB"] }
          },
          units: [
            { id: "DEVO", count: 3, hp: 1340, maxhp: 2010, vet: 2 },
            { id: "MIND", count: 2, hp: 505, maxhp: 1010, vet: 1 },
            { id: "DISK", count: 2, hp: 440, maxhp: 880, vet: 1 },
            { id: "BRUTE", count: 5, hp: 900, maxhp: 1250, vet: 0 },
            { id: "PCV", count: 2, hp: 1200, maxhp: 1600, vet: 1 },
            { id: "IVAN", count: 2, hp: 200, maxhp: 240, vet: 0 }
          ]
        },
        {
          name: "灰烬协议", country: "Guild3", faction: "焚风", color: "#f8d038",
          cash: 7640, power: [450, 460], army: 4200, kills: 61, lost: 71, score: 43880,
          infiltration: { barracks: 1, war_factory: 1 },
          queues: {
            building: { id: "FABARR", pct: 12, next: ["FAWEAP"] },
            defense:  { id: "FASPIN", pct: 57, next: ["FASPIN"] },
            infantry: { id: "KNIGHT", pct: 93, next: [] },
            vehicle:  { id: "YTNK", pct: 5, next: ["YTNK"] },
            aircraft: { id: "HURR", pct: 22, next: ["HURR", "QUETZ"] }
          },
          units: [
            { id: "HARP", count: 6, hp: 420, maxhp: 600, vet: 1 },
            { id: "YTNK", count: 4, hp: 900, maxhp: 1200, vet: 0 },
            { id: "ZEP", count: 1, hp: 700, maxhp: 1000, vet: 0 },
            { id: "ENGINEER", count: 3, hp: 180, maxhp: 240, vet: 0 },
            { id: "E2", count: 6, hp: 480, maxhp: 600, vet: 0 }
          ]
        }
      ]
    },
    {
      key: "B",
      name: "分队 B",
      players: [
        {
          name: "紫电", country: "ScorpionCell", faction: "厄普西隆", color: "#b048f8",
          cash: 11320, power: [520, 300], army: 6200, kills: 104, lost: 44, score: 73510,
          infiltration: { barracks: 0, war_factory: 0 },
          queues: {
            building: { id: "NAREFN", pct: 47, next: ["NAWEAP"] },
            infantry: { id: "BRUTE", pct: 38, next: ["BRUTE"] },
            vehicle:  { id: "PCV", pct: 79, next: ["MIND", "DISK"] },
            navy:     { id: "SUB", pct: 15, next: [] }
          },
          units: [
            { id: "DEVO", count: 4, hp: 1780, maxhp: 2680, vet: 1 },
            { id: "MIND", count: 3, hp: 760, maxhp: 1515, vet: 0 },
            { id: "DISK", count: 1, hp: 220, maxhp: 440, vet: 0 },
            { id: "BRUTE", count: 4, hp: 720, maxhp: 1000, vet: 1 },
            { id: "PCV", count: 3, hp: 1800, maxhp: 2400, vet: 0 }
          ]
        },
        {
          name: "白鲸", country: "Pacific", faction: "盟军", color: "#38e0f8",
          cash: 8850, power: [400, 410], army: 5100, kills: 79, lost: 58, score: 55120,
          infiltration: { barracks: 0, war_factory: 1 },
          queues: {
            building: { id: "GAYARD", pct: 74, next: [] },
            defense:  { id: "NASAM", pct: 8, next: ["NASAM"] },
            infantry: { id: "E1", pct: 61, next: ["SPY"] },
            vehicle:  { id: "LTNK", pct: 43, next: ["LTNK"] },
            navy:     { id: "AEGIS", pct: 67, next: ["CARRIER"] }
          },
          units: [
            { id: "LTNK", count: 6, hp: 1500, maxhp: 1800, vet: 1 },
            { id: "AEGIS", count: 4, hp: 1000, maxhp: 1200, vet: 0 },
            { id: "HARP", count: 3, hp: 225, maxhp: 300, vet: 1 },
            { id: "TANY", count: 1, hp: 500, maxhp: 500, vet: 1 },
            { id: "SPY", count: 1, hp: 75, maxhp: 100, vet: 0 },
            { id: "AMCV", count: 1, hp: 800, maxhp: 1000, vet: 0 }
          ]
        },
        {
          name: "赤砂", country: "Latin", faction: "苏联", color: "#f89838",
          cash: 13480, power: [600, 520], army: 7300, kills: 121, lost: 39, score: 88760,
          infiltration: { barracks: 1, war_factory: 0 },
          queues: {
            building: { id: "NATECH", pct: 23, next: [] },
            defense:  { id: "NAFLAK", pct: 91, next: [] },
            infantry: { id: "DESO", pct: 14, next: ["DESO", "IVAN"] },
            vehicle:  { id: "APOC", pct: 56, next: ["HTNK", "HTNK"] },
            aircraft: { id: "ZEP", pct: 33, next: [] }
          },
          units: [
            { id: "HTNK", count: 7, hp: 3080, maxhp: 3850, vet: 2 },
            { id: "APOC", count: 1, hp: 800, maxhp: 1000, vet: 1 },
            { id: "SHK", count: 3, hp: 315, maxhp: 375, vet: 1 },
            { id: "FLAKT", count: 4, hp: 720, maxhp: 960, vet: 0 },
            { id: "DESO", count: 2, hp: 200, maxhp: 240, vet: 0 },
            { id: "YDOG", count: 4, hp: 120, maxhp: 160, vet: 0 },
            { id: "SMCV", count: 1, hp: 900, maxhp: 1000, vet: 0 }
          ]
        },
        {
          name: "黑曜石", country: "Guild1", faction: "焚风", color: "#f848a8",
          cash: 6420, power: [350, 290], army: 3600, kills: 48, lost: 83, score: 34110,
          infiltration: { barracks: 0, war_factory: 0 },
          queues: {
            building: { id: "FACNST", pct: 40, next: [] },
            infantry: { id: "E1", pct: 71, next: ["ENGINEER"] },
            vehicle:  { id: "YTNK", pct: 26, next: [] }
          },
          units: [
            { id: "YTNK", count: 3, hp: 675, maxhp: 900, vet: 0 },
            { id: "HARP", count: 5, hp: 350, maxhp: 500, vet: 0 },
            { id: "ENGINEER", count: 2, hp: 120, maxhp: 160, vet: 0 },
            { id: "E1", count: 7, hp: 350, maxhp: 560, vet: 0 },
            { id: "FLAKT", count: 2, hp: 360, maxhp: 480, vet: 0 }
          ]
        }
      ]
    }
  ]
};
