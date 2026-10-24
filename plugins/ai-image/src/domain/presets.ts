import { invalidRequest } from './errors.js'

export interface ScenePreset {
  id: string
  label: string
  category: string
  hint: string
  prompt: string
}

/** Original prompts authored for this plugin; legacy IDs remain stable. */
export const PRESERVE =
  'Use the reference product as the source of truth. Preserve its exact shape, proportions, material, colour, readable markings, labels, logos, artwork and text, including spelling and punctuation. Preserve the actual secondhand condition: every visible scratch, stain, dent, chip, crease, faded area, worn edge, missing part and repair. Do not clean, restore, polish, retouch away defects, complete missing parts or make the item look newer. Do not invent hidden details, unreadable text, brands, accessories or additional items for sale. Change only the surroundings and plausible ambient lighting; keep condition and markings visible.'

const EVERYDAY =
  'An honest phone photo for a secondhand listing in an ordinary European or US home. Natural perspective, realistic scale and modest ambient light; the item and its condition are in focus. No glamorous styling, studio sweep, dramatic lighting, artificial portrait blur, beauty filter, advertising layout, added lettering or watermark. Any household objects at the edge are background context, not included accessories.'

type Scene = readonly [id: string, label: string, hint: string, prompt: string]

function group(category: string, scenes: readonly Scene[]): ScenePreset[] {
  return scenes.map(([id, label, hint, prompt]) => ({
    id,
    label,
    category,
    hint,
    prompt: `${prompt} ${EVERYDAY}`,
  }))
}

export const SCENE_PRESETS: readonly ScenePreset[] = [
  ...group('素色家居', [
    [
      'white-studio',
      '白墙小桌',
      '白漆墙与家用小桌，阴天窗光',
      'Place the item on a small white laminate table against a slightly uneven white painted wall in a modest US apartment. Include the real table-to-wall junction and a soft side-window shadow. Photograph from just above the tabletop, leaving space around the full item.',
    ],
    [
      'grey-studio',
      '灰墙边柜',
      '浅灰墙与旧边柜，平视随拍',
      'Set the item on a used sideboard against a matte light-grey wall in a British flat. Let a small strip of the sideboard edge show. Use overcast window light and a level handheld view, with ordinary uneven shadows rather than a gradient backdrop.',
    ],
    [
      'cream-wall-floor',
      '米墙地板',
      '米色墙脚，适合较大物件',
      'Stand the item on honey-coloured laminate flooring beside a cream wall and white skirting board in an everyday European rental. Take a slightly downward phone photograph from a practical distance, showing its complete footprint and contact shadow.',
    ],
    [
      'white-sheet-table',
      '白布餐桌',
      '普通白布铺桌，保留自然褶皱',
      'Place the item on a plain cotton sheet casually spread across a small American dining table. Keep a few fabric folds visible beyond the item and a little table edge in frame. Use nearby window light and a near-overhead phone view, with no seamless backdrop.',
    ],
    [
      'kraft-paper-table',
      '纸垫木桌',
      '牛皮纸保护桌面，平实俯拍',
      'Rest the item on a piece of plain brown packing paper laid flat on a European kitchen table. Keep the paper edges and worn wood visible. Photograph almost overhead in midday window light; the paper protects the table and is not gift wrapping.',
    ],
    [
      'pale-door-backdrop',
      '白门旁拍',
      '普通内门作背景，保留门框',
      'Position the item in front of an off-white interior door in a US home, using a low plain stool if it needs support. Include part of the door frame for scale. Shoot at item height with indirect hallway daylight, without leaning fragile objects unsafely.',
    ],
    [
      'linen-mat-console',
      '麻垫玄台',
      '玄关布垫，短距离随拍',
      'Set the item on a small undyed linen mat on a narrow entry console in a French apartment. Show the mat edge and a little scuffed console surface. Use soft light entering from the adjacent room and a gentle three-quarter phone angle.',
    ],
    [
      'cork-mat-surface',
      '软木垫桌',
      '软木隔热垫，适合小件',
      'Place the small item on an ordinary cork mat on a Scandinavian apartment table. Keep the cork texture and tabletop boundary visible without surrounding props. Photograph at a shallow downward angle in cloudy daylight, preserving the true item size.',
    ],
    [
      'plain-wall-chair',
      '墙边木椅',
      '普通木椅作承托，侧窗光',
      'Rest a suitably sized item on the seat of a plain wooden kitchen chair against an unadorned wall in a German flat. Include the seat front and chair back as context. Use a casual elevated view from the window side, with the item unobstructed.',
    ],
    [
      'cotton-towel-counter',
      '棉巾台面',
      '浅色毛巾垫底，适合易刮小件',
      'Lay the item on a folded pale cotton hand towel on a utility counter in an American home. Show the towel fold and a narrow band of the counter. Photograph from above in diffuse daylight so surface defects remain readable, without making the towel look like packaging.',
    ],
  ]),
  ...group('客厅角落', [
    [
      'home-sofa',
      '布艺沙发',
      '日常沙发坐垫，自然侧光',
      'Place the item on a slightly used fabric sofa seat in a British living room. Show the seat seam and one plain cushion well away from the product. Photograph from standing height with side-window daylight, keeping the item fully visible rather than sinking into the cushion.',
    ],
    [
      'wall-hang',
      '客厅挂墙',
      '墙面挂件，适用已有挂点的商品',
      'Hang an item that already has a suitable hanging point on an existing hook on a plain living-room wall in a European flat. Include a sliver of the sideboard below. Photograph straight on in window light; do not add a frame, hanger or mounting hardware to the product.',
    ],
    [
      'coffee-table-rug',
      '茶几地毯',
      '低茶几与旧地毯，斜上方视角',
      'Put the item on a low rectangular coffee table in an ordinary US living room. Include a small patch of the faded rug below and the table edge. Take a three-quarter phone photograph in indirect afternoon daylight, without a styled coffee-table arrangement.',
    ],
    [
      'armchair-seat',
      '单椅坐垫',
      '旧单人椅承托，侧前方随拍',
      'Rest the item on the firm seat of a plain armchair in an Irish sitting room. Keep the chair arm visible to one side and the product clear of the back cushion. Photograph from the front corner in overcast window light with everyday handheld framing.',
    ],
    [
      'tv-stand-corner',
      '电视柜角',
      '普通电视柜，适合电子小件',
      'Place the item on the clear end of a low television stand in a US apartment. The switched-off television appears only at the frame edge, without reflections obscuring the item. Use room daylight and a tabletop-level three-quarter view; do not add cables or remotes.',
    ],
    [
      'bookcase-low-shelf',
      '书柜下层',
      '家用书柜，少量旧书作远景',
      'Set the item on a mostly empty lower shelf of a modest European bookcase. Leave a few books on an adjacent shelf, separated from the item. Photograph straight on in available living-room light, showing the shelf edge and entire product without theatrical shelf lighting.',
    ],
    [
      'window-side-stool',
      '窗边矮凳',
      '窗旁木凳，柔和阴影',
      'Put the item on a sturdy low wooden stool beside a living-room window in a Dutch row house. Include a small section of the radiator below the window as distant context. Shoot down at a mild angle using cloudy daylight, with no sun flare or decorative plants.',
    ],
    [
      'living-room-parquet',
      '客厅拼木',
      '拼木地板，适合大件摆放',
      'Stand the item on slightly worn parquet flooring in an ordinary French living room, with a sofa leg at the far edge. Take a phone photo from a few steps away at a modest downward angle. Use even window light and retain the full outline and honest floor contact.',
    ],
    [
      'folding-table-lounge',
      '折桌客厅',
      '临时折叠桌，居家出售前随拍',
      'Place the item on a practical folding table set up in a US living room for resale photos. Show part of the table edge and a plain wall beyond. Photograph at a slight angle in daylight, with the temporary setup visibly ordinary and the item not professionally staged.',
    ],
    [
      'radiator-side-cabinet',
      '暖气边柜',
      '暖气旁矮柜，阴天自然光',
      'Set the item on a low cabinet beside, not on, a radiator in a Polish apartment. Let a section of the radiator and window sill appear behind it. Use flat overcast daylight and a straight handheld view, keeping the item safely supported and its surface texture visible.',
    ],
  ]),
  ...group('卧室织物', [
    [
      'bedroom-bed',
      '棉被床铺',
      '普通床铺，棉被轻微褶皱',
      'Lay the item on a plain cotton duvet on a made but not perfectly smooth bed in a British bedroom. Keep enough duvet folds visible to establish a home setting. Photograph from above near the bed edge in soft side-window light; do not smooth out the item itself.',
    ],
    [
      'quilt-bed-corner',
      '拼被床角',
      '美式旧棉被，床角斜拍',
      'Place the item near the corner of an everyday quilt-covered bed in a US home. Show a restrained strip of patchwork beyond the product and a little mattress edge. Use a high three-quarter phone angle and diffuse daylight, avoiding competing patterns under important markings.',
    ],
    [
      'bedroom-dresser',
      '卧室斗柜',
      '木制斗柜，适合配饰小件',
      'Set the item on a slightly worn wooden dresser in a European bedroom. Keep a plain wall behind it and the drawer-top edge visible below. Photograph from chest height with window light from the left, leaving no cosmetics, jewellery stands or styling props beside it.',
    ],
    [
      'nightstand-daylight',
      '床头小柜',
      '床头柜一角，近距离侧拍',
      'Place the small item on a simple bedside cabinet in a US bedroom. Include a narrow edge of the bed in the background, with the bedside lamp switched off. Take a close but undistorted phone photo in morning window light, showing every edge of the item.',
    ],
    [
      'bedroom-low-pile-rug',
      '短绒地毯',
      '低绒素色地毯，平铺俯拍',
      'Lay the item on a plain low-pile bedroom rug in a German apartment. Keep a short section of floorboards at the frame edge for context. Photograph directly from above in diffuse window light, ensuring the rug does not conceal small parts or the actual outline.',
    ],
    [
      'wardrobe-door-hook',
      '衣柜门钩',
      '衣柜外侧挂钩，普通正面拍',
      'Hang a suitable item by its existing loop or hanger from an over-door hook outside a wardrobe in a European bedroom. Include the door edge and adjacent wall. Photograph straight on in room daylight; do not invent loops, stretch the item or hide worn areas.',
    ],
    [
      'bed-end-bench',
      '床尾长凳',
      '普通床尾木凳，完整轮廓',
      'Rest the item on a plain wooden bench at the foot of a bed in a US home. Keep the neutral bedspread behind it and the bench legs partly visible. Use a standing-height three-quarter view in indirect daylight, with the item naturally supported rather than arranged decoratively.',
    ],
    [
      'guest-room-cotton',
      '客房床单',
      '备用房间床单，平实顶视',
      'Lay the item flat on an ordinary pale striped bedsheet in a small European guest room. Include a slight crease and the corner of a pillow at a distant edge. Shoot almost vertically downward with cloudy window light, preserving the item folds and signs of use.',
    ],
    [
      'storage-chest-top',
      '储物箱顶',
      '家用木箱上盖，正面斜俯拍',
      'Place the item on the closed lid of a scuffed wooden storage chest in an American spare bedroom. Show the lid seam and a little wall beyond it. Photograph from a mild downward angle with ordinary daylight, without adding rustic decorations or altering product wear.',
    ],
    [
      'bedroom-carpet-edge',
      '卧室地毯边',
      '地毯与踢脚线，适合箱包',
      'Stand the item on a clean area of everyday beige bedroom carpet near a skirting board in a British house. Keep the carpet-to-wall junction visible and the item clear of the wall. Photograph at knee height in soft daylight, showing its base and full silhouette.',
    ],
  ]),
  ...group('书桌餐桌', [
    [
      'wood-desk',
      '木质书桌',
      '普通书桌，桌边与窗光',
      'Place the item on a used wooden desk in a European home office. A closed notebook may sit well back at the frame edge, separate from the item. Photograph at a slightly elevated three-quarter angle using the desk window, with surface grain and real contact shadows visible.',
    ],
    [
      'laminate-study-desk',
      '层板书桌',
      '学生书桌，素白桌面俯拍',
      'Lay the item on a plain laminate study desk in a US apartment. Include a narrow desk edge and a small section of wall beyond. Take a near-overhead phone photo in natural daylight, without keyboards, branded desk mats or a curated workstation setup.',
    ],
    [
      'oak-dining-table',
      '橡木餐桌',
      '家用橡木餐桌，侧前方随拍',
      'Set the item on an ordinary oak dining table in a Dutch home. Show one chair back at the far edge and leave the rest of the table clear. Photograph from seated height in overcast window light, with no table setting, flowers or food props.',
    ],
    [
      'round-kitchen-table',
      '圆桌一角',
      '小户型圆餐桌，弧形边缘',
      'Place the item near the centre of a small round breakfast table in an American apartment. Let the curved tabletop edge establish scale. Shoot from a standing three-quarter angle in soft daylight, keeping all parts within the frame and the background practical and uncluttered.',
    ],
    [
      'folded-tablecloth',
      '格布餐桌',
      '普通小格桌布，垂直俯拍',
      'Lay the item on a modest checked cotton tablecloth on a French family dining table. Show a single fold near the edge. Use an overhead phone view in window light; the cloth must not overpower labels or imply a decorative still life.',
    ],
    [
      'drop-leaf-table',
      '折叶小桌',
      '公寓折叶餐桌，紧凑日常环境',
      'Set the item on the open leaf of a compact drop-leaf table in a British flat. Include the hinge seam and a little wall behind the table. Photograph from slightly above in available daylight, showing the small-space setup without cramped cropping of the item.',
    ],
    [
      'desk-cutting-mat',
      '切割垫桌',
      '旧素色切割垫，适合小工具',
      'Place the item on a used plain cutting mat on a hobby desk in a US home. Any grid is a background surface, not an invented measurement of the product. Photograph overhead in daylight, keeping the item complete and avoiding added tools or parts.',
    ],
    [
      'writing-bureau',
      '旧写字台',
      '日常旧木书台，平视桌面',
      'Set the item on the open writing surface of a modest used bureau in a European flat. Leave the back compartments mostly empty and show the front edge. Use a low three-quarter phone angle with soft side daylight, without antique styling or dramatic furniture photography.',
    ],
    [
      'dining-bench-top',
      '餐凳台面',
      '木制餐凳，长条商品适用',
      'Rest the item lengthwise on a sturdy dining bench in an American kitchen-dining room. Include the bench surface and a little tiled floor below. Take a high diagonal phone view in diffuse daylight, retaining believable scale and the entire item without stretching its proportions.',
    ],
    [
      'desk-window-blind',
      '百叶窗桌',
      '家用书桌，柔化百叶窗光',
      'Place the item on a simple desk beside half-open blinds in a Spanish apartment. Use softened daylight without hard striped shadows crossing the product. Photograph just above the desk, with a sliver of blind at the background edge and no cinematic light.',
    ],
  ]),
  ...group('厨房日常', [
    [
      'kitchen-counter',
      '厨房台面',
      '家用工作台，平视近拍',
      'Set the item on an everyday laminate kitchen counter in a US home, away from the sink and stove. Include a plain backsplash seam and part of a cupboard. Photograph near counter height in window light, leaving the surface clear and product markings readable.',
    ],
    [
      'tile-counter-corner',
      '瓷砖台角',
      '家用瓷砖台，轻微俯拍',
      'Place the item on a dry tiled counter in a modest southern European kitchen. Keep the grout lines and countertop corner visible as ordinary context. Shoot from a gentle downward angle in indirect daylight, with no food, water droplets or polished culinary styling.',
    ],
    [
      'butcher-block-counter',
      '木质操作台',
      '旧木工作台面，侧窗自然光',
      'Rest the item on a used butcher-block worktop in a British kitchen, with no food being prepared. Include a narrow strip of plain tiled wall. Use a three-quarter phone angle in soft window light, keeping the item distinct from the existing worktop wear.',
    ],
    [
      'kitchen-breakfast-bar',
      '早餐吧台',
      '普通吧台一角，空间感平实',
      'Set the item on a small breakfast bar in an American rental kitchen. Show one plain stool tucked underneath at the edge of frame. Photograph from slightly above in available daylight, with a normal phone field of view and no staged breakfast or drinks.',
    ],
    [
      'kitchen-open-shelf',
      '厨房搁板',
      '普通厨房木搁板，正面记录',
      'Place the item on a clear section of a sturdy kitchen shelf in a European apartment. A plain bowl may remain far to one side as background only. Photograph straight on with indirect window light, making shelf support obvious and avoiding added matching sets.',
    ],
    [
      'kitchen-utility-cart',
      '厨房推车',
      '小推车上层，斜前方拍摄',
      'Set the item on the top shelf of a practical kitchen trolley in a US home. Include a little of the handle and lower shelf, with no extra products. Shoot from standing height in even room daylight, keeping the trolley incidental rather than part of the sale.',
    ],
    [
      'kitchen-vinyl-floor',
      '厨房胶地',
      '普通厨房地面，适合较大物件',
      'Stand the item on a dry vinyl kitchen floor near a plain base cabinet in a British house. Include the cabinet kickboard for scale. Take a phone photo at waist height in diffuse daylight, keeping the whole item and its actual floor contact visible.',
    ],
    [
      'kitchen-window-ledge',
      '宽窗台',
      '厨房宽窗台，小件自然侧光',
      'Place a suitably small item on a broad dry kitchen window ledge in a German flat. Shoot from the side so daylight illuminates rather than silhouettes it. Include part of the window frame and avoid plants, bright glare or an outdoor view competing with the product.',
    ],
    [
      'pantry-step-stool',
      '储物间凳',
      '厨房储物间小凳，普通顶灯',
      'Rest the item on a sturdy step stool just inside a US pantry doorway. Keep shelves at a distant edge and avoid readable food packaging. Photograph at a mild downward angle under ordinary even ceiling light, without adding flash glare or changing the item colour.',
    ],
    [
      'kitchen-draining-side',
      '水槽旁台',
      '干燥台面，厨具适用',
      'Place the item on the dry clear section beside a stainless-steel sink in a European kitchen. Let only the sink rim appear at the far edge and add no water or soap. Shoot from above at a gentle angle in cloudy window light, showing surface condition plainly.',
    ],
  ]),
  ...group('玄关收纳', [
    [
      'store-shelf',
      '家用储物架',
      '自家储物架，替代零售陈列',
      'Set the item alone on a plain home storage shelf in a US spare room. Include the shelf edge and an unlabelled box on a separate level. Photograph straight on in room light: a private seller clearing storage, with no store signage, stock display or duplicate products.',
    ],
    [
      'entry-shoe-bench',
      '玄关鞋凳',
      '普通入户木凳，侧面自然光',
      'Place the item on a simple shoe bench in a European apartment entryway. Keep a little of the front door and floor mat in the background, away from the product. Photograph from standing height using light from the adjacent room, without styling the entryway.',
    ],
    [
      'hall-console',
      '走廊边台',
      '窄走廊小台，平视略俯',
      'Set the item on a narrow console in a US hallway. Show the wall corner and a little baseboard, with no mirror reflection or personal photographs. Take a mild downward phone view under mixed but neutral room daylight, preserving the real item colour.',
    ],
    [
      'stair-landing-floor',
      '楼梯平台',
      '楼梯平台平地，大件完整展示',
      'Stand the item on the level landing of a British house, well away from the stair edge. Include a small section of banister behind it for context. Photograph from a safe standing position in landing-window daylight, keeping the complete item unobstructed.',
    ],
    [
      'understairs-cupboard',
      '楼梯下柜',
      '储物柜前平地，清理闲置感',
      'Place the item on the floor just outside an open understairs cupboard in a European home. Show a restrained section of cupboard door and plain storage containers behind. Use a front three-quarter phone view with hallway light, without a dramatic dark background.',
    ],
    [
      'closet-shelf',
      '壁橱搁板',
      '家用壁橱空格，正面实拍',
      'Set the item on an empty shelf at chest height inside a US household closet. Keep the open door edge visible and other contents outside the main frame. Photograph straight on under normal room light, without adding wardrobe accessories or hiding marks in shadow.',
    ],
    [
      'entry-tile-floor',
      '门厅瓷砖',
      '入户瓷砖地面，适合箱包',
      'Stand the item on plain entryway tiles in an Italian apartment, with the lower door frame visible behind it. Photograph from knee height in open-door daylight, showing its whole base and sides. Keep the exterior view out of frame and preserve the real used condition.',
    ],
    [
      'plastic-storage-lid',
      '收纳箱盖',
      '普通塑料箱作支撑，小件适用',
      'Rest the item on the closed flat lid of a sturdy plastic storage tote in a US home. Include the tote rim and a plain wall beyond. Shoot from slightly above in diffuse daylight, making clear the tote is household support, not original product packaging.',
    ],
    [
      'coatroom-shelf',
      '衣帽间层板',
      '入门衣帽间，哑光层板随拍',
      'Place the item on a clear shelf in a modest Scandinavian coatroom. Show a little plain hanging rail at the side, leaving other belongings distant and unobtrusive. Photograph at shelf height in available light, without a luxury wardrobe aesthetic or added clothing accessories.',
    ],
    [
      'hallway-folding-chair',
      '走廊折椅',
      '家用折椅座面，临时展示',
      'Rest a suitable item on a fully opened folding chair against a plain hallway wall in an American apartment. Keep the seat edge and part of the chair frame visible. Use a high three-quarter phone view in nearby window light, with no balancing or unrealistic placement.',
    ],
  ]),
  ...group('庭院阳台', [
    [
      'outdoor-daylight',
      '阴天院桌',
      '后院普通桌面，阴天散射光',
      'Place the item on an everyday outdoor table in a British back garden on an overcast day. Include a narrow strip of grass and plain fence beyond. Photograph from a mild downward angle with soft natural shadows, without picturesque garden styling or changing product weathering.',
    ],
    [
      'apartment-balcony',
      '公寓阳台',
      '欧洲小阳台桌，开阔阴影',
      'Set the item on a small plain table on a European apartment balcony in open shade. Include part of the railing and tiled floor, keeping distant buildings unobtrusive. Photograph from the inside corner with level phone perspective, no skyline glamour or hard sunlight on the item.',
    ],
    [
      'covered-porch',
      '门廊木凳',
      '美式有顶门廊，木凳承托',
      'Rest the item on a simple bench under a covered US front porch. Show porch boards and a little house siding. Use soft open-shade daylight and a three-quarter phone view, excluding house numbers and decorative seasonal displays while keeping the whole product visible.',
    ],
    [
      'patio-paving',
      '露台砖地',
      '普通露台铺砖，适合大件',
      'Stand the item on dry paving slabs in a modest European patio. Include a wall-to-ground junction and a little adjacent slab. Photograph from waist height on an overcast day, showing the full footprint without plants framing the item or a landscaped luxury setting.',
    ],
    [
      'wood-deck-corner',
      '木露台角',
      '家用木平台，侧前方记录',
      'Place the item on a US backyard deck in open shade near plain siding. Show weathered board lines for context, keeping the product wear distinct. Take a front three-quarter phone photograph with the whole item visible and no barbecue or entertaining props.',
    ],
    [
      'garden-plastic-table',
      '塑料院桌',
      '普通塑料花园桌，平实俯拍',
      'Set the item on a used white plastic garden table in a French suburban yard. Keep the table edge and one chair leg at the margin. Photograph from above at a mild angle in cloudy daylight, with ordinary table scuffs and no catalogue lighting.',
    ],
    [
      'courtyard-step',
      '院内台阶',
      '宽阔低台阶，适合稳固小件',
      'Rest the item safely on a broad low courtyard step in a Spanish home, away from the walking path. Include a plain rendered wall and part of the next step. Shoot at item height in open shade, retaining natural texture without travel-photo colour grading.',
    ],
    [
      'garage-door-shade',
      '车库门前',
      '车库门边阴影，大件生活照',
      'Stand the item on a clean dry patch of driveway in the shade of a US garage doorway. Show part of the closed garage door behind it and no vehicles or licence plates. Photograph straight on at waist height, with ordinary daylight and accurate scale.',
    ],
    [
      'backdoor-doormat',
      '后门垫边',
      '后门干燥地面，家用小件',
      'Place the item on the dry paved area beside, not on, a plain backdoor mat in a British home. Keep the door threshold at the background edge. Take a high three-quarter phone view in soft daylight without introducing dirt or weather damage to the item.',
    ],
    [
      'balcony-folding-chair',
      '阳台折椅',
      '小阳台折椅，普通阴天光',
      'Rest a suitable item on the flat seat of a simple folding balcony chair in a German apartment. Include part of the chair back and balcony floor. Photograph from the front corner in overcast light, with no cushions, cafe styling or distant scenic emphasis.',
    ],
  ]),
  ...group('衣物鞋包', [
    [
      'door-hanger-garment',
      '门上衣架',
      '现有衣架挂门，正面展示衣物',
      'For a garment, use a plain hanger on a bedroom door hook in a British home. Photograph straight on with the full hem and sleeves visible in window light. Retain creases, pilling, stains and label details; do not tailor the fit, add a brand or introduce a model.',
    ],
    [
      'wardrobe-rail-garment',
      '衣杆单挂',
      '家用衣杆单件，保留自然垂坠',
      'Hang the garment alone on an ordinary wardrobe rail in a European bedroom. Keep a little rail and door frame visible with no adjacent outfits. Shoot at garment height in diffuse daylight, preserving its actual shape and worn fabric rather than steaming, reshaping or styling it.',
    ],
    [
      'jeans-floor-flatlay',
      '地板平铺',
      '衣裤平铺木地板，完整轮廓',
      'Lay the clothing naturally on a clear wooden bedroom floor in a US home. Arrange only enough to see its outline; retain real folds, knee wear and frayed edges. Photograph directly overhead in soft daylight with all cuffs included, no outfit accessories or decorative shoes.',
    ],
    [
      'knit-folded-dresser',
      '针织叠放',
      '针织衣物轻叠，纹理与磨损可见',
      'Place knitwear in a loose practical fold on a bedroom dresser in a Scandinavian home, without hiding worn or stained areas. Use an elevated phone angle and diffuse side daylight to retain real knit texture and pilling. Do not add labels, smooth fibres or imply new condition.',
    ],
    [
      'shoes-entry-pair',
      '鞋凳摆鞋',
      '鞋具靠近玄关，日常角度',
      'Place the footwear on a plain entry bench in a US home. Preserve the exact number of shoes in the reference and never invent a matching shoe. Photograph from a front three-quarter angle in daylight so toe scuffs, creases and edge wear remain visible, without stuffing or polishing.',
    ],
    [
      'shoe-side-floor',
      '鞋侧地面',
      '鞋侧视角，鞋边与磨损清楚',
      'Set the footwear naturally on a dry tiled hallway floor in a European flat. Take a low side three-quarter phone view, retaining visible sole-edge wear and uppers as documented. Keep skirting board in frame; do not invent unseen tread or make worn material look fresh.',
    ],
    [
      'bag-chair-back',
      '包袋椅背',
      '现有提带搭椅，保持包型',
      'Drape the bag by its existing strap over a plain dining chair in a French apartment, only if that strap is visible in the reference. Photograph at chair height in window light, retaining sagging, scuffs and damaged hardware without stuffing the bag or adding charms.',
    ],
    [
      'bag-entry-console',
      '包袋玄台',
      '包袋放玄关台，拉链细节可见',
      'Stand or rest the bag naturally on a narrow entry console in a US home, following its real structure. Use a mild downward three-quarter view in diffuse daylight. Preserve zipper wear, stains and creases, with no added contents, replacement straps or boutique presentation.',
    ],
    [
      'hat-linen-bed',
      '帽子床铺',
      '帽饰放素色床单，自然形状',
      'Rest the hat or soft accessory on a plain linen-coloured bedsheet in a European bedroom. Photograph from a slightly elevated angle showing its existing brim or edges. Preserve dents, fading and fabric wear; do not reshape it on a mannequin or add stuffing, in ordinary window light.',
    ],
    [
      'scarf-blanket-flatlay',
      '围巾铺毯',
      '织物铺素色薄毯，边角留全',
      'Lay the scarf or textile on a plain thin blanket in a British spare room, keeping visible fringes and edges within frame. Take an overhead phone photo in diffuse daylight. Retain pilling, pulls, uneven edges and genuine folds, without matching accessories or smoothing away damage.',
    ],
  ]),
  ...group('手持细节', [
    [
      'hand-hold',
      '单手托物',
      '小件自然托住，墙前日光',
      'For an item small enough to hold safely, support it in one adult hand against a plain wall in a US home. Keep fingers away from markings and defects and show the whole item. Use a normal phone distance in soft daylight, without styled nails, jewellery props or altered scale.',
    ],
    [
      'two-hands-support',
      '双手轻托',
      '双手承托中小件，素色衣袖',
      'Support a suitable item with two adult hands above a plain kitchen table in a European home. Keep only hands and plain sleeves in frame, with no face visible. Photograph at a natural phone distance in daylight; fingers must not cover damage, labels or edges.',
    ],
    [
      'hand-window-light',
      '窗边手持',
      '小件靠窗，避开反光遮挡',
      'Hold the small item beside an ordinary apartment window in Europe, with the window frame at one edge. Turn the camera rather than altering the product to avoid glare over markings. Use soft side daylight, realistic fingers and a modest close view including the entire item.',
    ],
    [
      'label-desk-closeup',
      '标签近拍',
      '已有标签特写，保持文字原样',
      'Photograph the existing visible product label closely on a plain US home desk, with surrounding material showing where it belongs. Use diffuse daylight and normal close phone focus. Preserve every legible character and actual label wear; never invent letters, certifications or an unseen label.',
    ],
    [
      'wear-table-closeup',
      '磨损近拍',
      '实有磨损细节，桌面均匀光',
      'Take a close phone photograph of wear already visible in the reference, with the item supported on a European kitchen table. Show surrounding intact material under even daylight. Do not exaggerate, remove or invent scratches and stains; if no damage is visible, show the surface honestly.',
    ],
    [
      'hardware-side-detail',
      '五金细节',
      '现有扣件或接缝，斜侧近拍',
      'Photograph an already visible fastening, hinge or hardware area on the item resting on a plain US household table. Use a slight side angle and broad daylight to show actual tarnish and scuffs. Do not open, replace or invent hardware; retain surrounding material for orientation.',
    ],
    [
      'fabric-texture-detail',
      '织物纹理',
      '已有面料细节，柔和斜向窗光',
      'Take a close photograph of the existing fabric texture while the item lies naturally on a plain bed in a European home. Use soft side light to show real weave, pilling and pulls. Keep the visible pattern and colour faithful, with no artificial macro sharpening or smoothing.',
    ],
    [
      'underside-visible-detail',
      '可见底面',
      '仅展示参考已见底面，不补猜信息',
      'If the underside is already shown in the reference, photograph that area on a plain cotton towel on a US table. Keep contact points and existing stamps legible in diffuse daylight. Never invent unseen underside details; otherwise retain the reference view and show the available surface.',
    ],
    [
      'edge-seam-detail',
      '边缘接缝',
      '商品边缘近拍，保留真实损伤',
      'Photograph an existing visible edge or seam with the item supported on a plain wooden table in a British flat. Use an oblique phone angle and gentle window light revealing genuine fraying, chips or separation. Keep enough surrounding surface for orientation without inventing defects.',
    ],
    [
      'hand-scale-table',
      '手掌比照',
      '手掌在旁示意尺度，不加尺标',
      'Place the item on an ordinary American dining table with one adult hand resting beside it, not covering it. Photograph nearly overhead in natural light for casual scale context. Do not add ruler markings or measurements, resize the item relative to the hand, or hide condition details.',
    ],
  ]),
  ...group('家务兴趣', [
    [
      'utility-room-shelf',
      '家务间架',
      '普通洗衣房架面，实用环境',
      'Set the item on a clear shelf in a US utility room, away from liquids and operating appliances. Include a narrow section of plain cabinet behind it. Photograph straight on under even available room light, with no cleaning products arranged around it or restored-looking finish.',
    ],
    [
      'laundry-folding-table',
      '洗衣折衣台',
      '干燥折衣台，窗边生活光',
      'Place the item on a dry folding table in a European laundry room. Keep a folded household towel far at the edge as context only. Take an elevated phone photo in soft window light, preserving condition and avoiding detergent packages, steam or a spotless showroom impression.',
    ],
    [
      'garage-workbench',
      '车库工作台',
      '旧工作台，小工具或配件适用',
      'Rest the item on a clear section of a used workbench in an American garage. Show a little bench edge and plain pegboard behind it without extra tools for sale. Photograph from slightly above in open-door daylight, keeping scratches and wear visible without adding grime.',
    ],
    [
      'hobby-room-table',
      '兴趣室桌',
      '家庭手作桌，普通工作痕迹',
      'Place the item on a practical hobby-room table in a British house. Include a distant plain storage tray with no contents visible. Use a near-overhead phone view in daylight, keeping tabletop wear incidental and never adding missing pieces, decorative craft supplies or finished artwork.',
    ],
    [
      'sewing-table-corner',
      '缝纫桌角',
      '家用缝纫桌，织物用品适用',
      'Set the item on the clear end of a sewing table in a European spare room. A covered sewing machine may appear only at the far background edge. Photograph at a mild downward angle in window light, with no thread sets, measuring claims or repairs to the item.',
    ],
    [
      'boardgame-dining',
      '餐桌藏物',
      '兴趣藏品放餐桌，不补齐配件',
      'Place the hobby item or its existing packaging on a plain US dining table as a private seller would document it. Show only pieces present in the reference, keeping missing parts missing. Use an overhead three-quarter phone view in diffuse daylight; no invented complete set or pristine box art.',
    ],
    [
      'music-room-stool',
      '琴房矮凳',
      '家用练习角，小件或配件适用',
      'Rest the item on a sturdy plain stool in a modest European music-practice corner. Show bare floor and wall, without adding instruments, cables or cases. Photograph at item height in available window light, preserving every visible chip and worn surface rather than a performance aesthetic.',
    ],
    [
      'bike-storage-floor',
      '单车储物角',
      '家庭储物地面，运动用品适用',
      'Stand or lay the item securely on a dry storage-room floor in a US home. Include the wall base and a plain shelving leg at the margin, without adding a bicycle or equipment. Use a front three-quarter phone angle in doorway daylight, keeping all actual parts and wear visible.',
    ],
    [
      'spare-room-packing',
      '闲置打包桌',
      '打包前桌面，纸箱仅作背景',
      'Place the item on a plain table in a European spare room with an open unbranded shipping carton well behind it. Photograph before packing in ordinary window light. Keep the carton visibly separate, do not imply original packaging or add accessories, and show condition without concealment.',
    ],
    [
      'basement-folding-table',
      '地下室折桌',
      '美式储物室，普通顶灯记录',
      'Set the item on a practical folding table in a dry American basement storage room. Show a small area of painted wall and a distant shelf. Take a straightforward slightly elevated phone photo under neutral ceiling light, with realistic mild phone noise and no dramatic shadows hiding defects.',
    ],
  ]),
]

const PRESET_INDEX = new Map(SCENE_PRESETS.map((preset) => [preset.id, preset]))

export function presetById(id: string): ScenePreset | null {
  return PRESET_INDEX.get(id) ?? null
}

/** Free prompts stay unchanged; accepted constraints are never sliced. */
export function composePrompt(presetId: string | null, userPrompt: string): string {
  if (presetId === null) return userPrompt
  const preset = presetById(presetId)
  if (preset === null) throw invalidRequest('场景预设不存在')
  const parts = [PRESERVE, preset.prompt]
  if (userPrompt.trim() !== '') parts.push(`Additional requirements: ${userPrompt}`)
  return parts.join('\n\n')
}

/** Labels are snapshotted onto the record so history survives a preset rename. */
export function presetLabel(presetId: string | null): string | null {
  if (presetId === null) return null
  return presetById(presetId)?.label ?? null
}
