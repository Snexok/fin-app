import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { root, skill, python, Presentation, PresentationFile, PDFDocument, sharp, finalizePresentation, resolvePresentationFont } from './story-runtime.mjs';

const assets = path.join(root, 'output/trailer-cinema/assets');
await fs.mkdir(path.join(root, '.build'), { recursive: true });
const work = await fs.mkdtemp(path.join(root, '.build/cinema-'));
const out = path.join(work, 'export');
await fs.mkdir(path.join(out, 'slides'), { recursive: true });
const font = resolvePresentationFont({ fontFamily: 'Arial' });
const p = Presentation.create({ slideSize: { width: 1280, height: 720 } });
const white = '#FFF8EE', muted = '#E1E7E6', teal = '#A5ECE1';
const disclosure = '\n\nИсточник: README.md и output/trailer/entertainment-playbook.md. Герои вымышленные. Продукт на стадии концепта. Telegram-бот и Mini App планируются. Финансовые расчеты выполняет отдельный детерминированный модуль, LLM понимает ввод и объясняет результат. Решение принимает пользователь. Все финансовые суммы в истории иллюстративные.';

function text(s, value, x, y, w, h, size, color = white, bold = false) {
  const box = s.shapes.add({ geometry: 'textbox', position: { left:x, top:y, width:w, height:h }, fill:'none', line:{ fill:'none', width:0 } });
  box.text = value;
  box.text.style = { typeface:font, fontSize:size, color, bold, autoFit:'none', verticalAlignment:'top' };
}

async function scene(asset, notes, strong = false) {
  const s = p.slides.add();
  s.images.add({ blob:new Uint8Array(await fs.readFile(asset)), contentType:'image/png', alt:path.basename(asset, '.png'), fit:'cover', position:{left:0,top:0,width:1280,height:720} });
  // A transparent wash preserves full-frame artwork while protecting type contrast.
  s.shapes.add({ geometry:'rect', position:{left:0,top:0,width:1280,height:720},
    fill:{type:'gradient', gradientKind:'linear', angleDeg:0, stops:[
      {offset:0,color:`#071720/${strong ? 92 : 80}`},
      {offset:42000,color:`#071720/${strong ? 84 : 60}`},
      {offset:78000,color:'#071720/12'}, {offset:100000,color:'#071720/3'}]},
    line:{fill:'none',width:0} });
  s.speakerNotes.textFrame.setText(notes + disclosure);
  return s;
}

let s = await scene(path.join(assets,'desire.png'), 'Завязка. Героиня замечает наушники в витрине. Камера медленно приближается, город затихает. Желание приятное, без стыда. Можно кратко показать ее музыкальную фантазию.');
text(s,'Можно?',64,55,560,65,36,teal,true);
text(s,'Хочется купить.\nА можно?',64,230,720,210,68,white,true);
text(s,'Личный финансовый коуч. Концепт.',64,645,760,32,20,muted);

s = await scene(path.join(assets,'question.png'), 'Героиня смотрит на остаток на карте и сомневается. Баланс не показывает, какая часть денег уже нужна на обязательства, базовые расходы и резерв. Достаточность средств зависит от введенных исходных данных.');
text(s,'На карте деньги есть',64,160,715,85,52,white,true);
text(s,'Но сколько из них\nсвободно?',64,270,740,180,63,white,true);

s = await scene(path.join(assets,'plans.png'), 'Аренда с ключами, Продукты с пакетом и Подушка-резерв появляются как доброжелательные незваные гости. Аренда спрашивает: А я в этом сезоне буду? Музыка обрывается на короткую паузу. Это метафора запланированных расходов, не наказание за желание купить. На Подушке пока нет наушников.');
text(s,'У этих денег\nуже есть планы',64,140,715,180,64,white,true);
text(s,'Аренда. Продукты. Резерв.',64,495,720,55,29,muted);

s = await scene(path.join(assets,'question.png'), 'Героиня задает вопрос и подтверждает текущий остаток, обязательства, резерв и будущие базовые расходы. Показанная история иллюстрирует планируемый сценарий. В будущем ролике добавить отдельную читаемую вставку интерфейса без банковской авторизации и без оплаты от имени продукта.');
text(s,'Спрашиваем\nМожно?',64,115,710,180,64,white,true);
text(s,'Наушники за 12 000 ₽.\nКак изменится мой план?',64,425,740,115,33,muted);

s = await scene(path.join(assets,'result.png'), 'Главный результат. 120000 - 45000 обязательств - 30000 резерва - 18000 будущих базовых расходов = 27000 свободных. Покупка 12 000 ₽ оставляет 15 000 ₽. Период 12-25 сентября включительно, 14 дней. Ожидаемый доход 25 сентября не включен до зачисления. На основном слайде одна сумма; подробности на последнем слайде.');
text(s,'После покупки останется',64,115,735,60,35,white);
text(s,'15 000 ₽',64,220,755,150,112,teal,true);
text(s,'На необязательные траты\nдо конца 25 сентября.',64,425,705,100,33,white);
text(s,'Пример расчета. Базовые расходы и резерв учтены.',64,643,1120,34,19,muted);

s = await scene(path.join(assets,'decision.png'), 'Героиня понимает последствия и сама выбирает покупку. Музыка возвращается мягче, спокойная прогулка. Приложение не платит и не запрещает. Альтернативный финал с теми же цифрами: она оставляет больше свободных денег и откладывает покупку.');
text(s,'Решение\nостается за тобой',64,155,745,195,64,white,true);
text(s,'Купить сейчас или оставить\nбольше свободных денег.',64,485,740,100,30,muted);

s = await scene(path.join(assets,'finale.png'), 'Финальный кадр: наушники и телефон на столике, Подушка примеряет маленькие наушники. За кадром: Тебе тоже? Короткая музыкальная точка. Версия на 15 секунд: 0-3 желание, 3-6 появление Аренды, 6-11 вопрос и результат 15 000 ₽, 11-15 решение и финальный титр. Одна основная сумма, без дневного ориентира. Не добавлять призыв скачать несуществующий продукт.');
text(s,'Можно?',64,125,715,130,90,white,true);
text(s,'Понятно, что останется\nпосле покупки',64,315,785,155,54,white,true);
text(s,'Концепт будущего продукта',64,643,1030,35,20,muted);

s = await scene(path.join(root,'output/assets/09-engine.png'), 'Приложение с проверяемым расчетом. Обязательства 45 000 ₽ включают аренду 35 000 ₽, кредит 9 000 ₽ и подписку 1 000 ₽. Резерв 30 000 ₽ включает защищенную цель, повторно не вычитаем. Базовые будущие расходы 18 000 ₽ уже выделены. Дневной ориентир относится только к оставшимся необязательным тратам. Доход 80 000 ₽ ожидается 25 сентября и будет учтен после фактического зачисления.', true);
text(s,'Как получились 15 000 ₽',64,45,1090,75,48,white,true);
const amounts = [120000,-45000,-30000,-18000,27000,-12000,15000];
if (amounts.slice(0,4).reduce((a,b)=>a+b,0)!==27000 || amounts[4]+amounts[5]!==15000) throw new Error('Illustrative calculation mismatch');
const rows = [['Остаток на карте','120 000 ₽'],['Обязательные платежи','−45 000 ₽'],['Резерв','−30 000 ₽'],['Базовые будущие расходы','−18 000 ₽'],['Свободно до покупки','27 000 ₽'],['Наушники','−12 000 ₽'],['После покупки','15 000 ₽']];
const table = s.tables.add({rows:7,columns:2,left:64,top:164,width:758,height:350,columnWidths:[490,268],values:rows});
table.borders.assign({fill:'none',width:0});
for(let r=0;r<7;r++) { table.rows[r].height=50; for(let c=0;c<2;c++) {const cell=table.getCell(r,c);cell.fill='none';cell.text.style={typeface:font,fontSize:27,color:r===6?teal:white,bold:r===6,alignment:c===1?'right':'left'};} }
text(s,'12-25 сентября: 14 дней. На необязательные траты:\n1 071 ₽ в день и остаток 6 ₽.',64,570,1085,75,24,white);
text(s,'Иллюстративные данные. Ожидаемый доход учтем после зачисления.',64,666,1135,30,18,muted);

const candidate = path.join(work,'candidate.pptx');
await (await PresentationFile.exportPptx(p)).save(candidate);
const validated = await finalizePresentation({workspaceDir:root,candidatePath:candidate,finalPath:path.join(out,'mozhno-cinema.pptx'),pythonExecutable:python,
  integrityValidatorPath:path.join(skill,'container_tools/inspect_presentation_package_integrity.py'),layoutValidatorPath:path.join(skill,'container_tools/inspect_presentation_layout_geometry.py'),
  layoutArgs:['--expected-slide-size-emu','12192000,6858000','--validate-heading-fit','--require-native-table-slide','8'],
  explicitTotalSlideCount:8,requiredNativeTableOwnerSlides:[8],
  // The packaged arithmetic parser does not support spaced Russian amounts or ₽.
  // check-cinema.py checks the actual exported native cells and both sums below.
  fontPolicy:{basis:'design',families:[font]},verifyArtifactToolImport:true,receiptPath:path.join(work,'validation.json')});

const pdf = await PDFDocument.create();
const contact = [];
for(let i=0;i<p.slides.items.length;i++) {
  const png = new Uint8Array(await (await p.export({slide:p.slides.items[i],format:'png',scale:1.5})).arrayBuffer());
  await fs.writeFile(path.join(out,'slides',`slide-${String(i+1).padStart(2,'0')}.png`),png);
  const jpeg = await sharp(png).jpeg({quality:95,chromaSubsampling:'4:4:4'}).toBuffer();
  const image = await pdf.embedJpg(jpeg);pdf.addPage([960,540]).drawImage(image,{x:0,y:0,width:960,height:540});
  contact.push({input:await sharp(png).resize(640,360).toBuffer(),left:(i%2)*640,top:Math.floor(i/2)*360});
  console.log(`Rendered ${i+1}/8`);
}
pdf.setTitle('Можно? Пойми, что останется после покупки');pdf.setLanguage('ru-RU');
await fs.writeFile(path.join(out,'mozhno-cinema.pdf'),await pdf.save());
await sharp({create:{width:1280,height:1440,channels:3,background:'#071720'}}).composite(contact).png().toFile(path.join(out,'overview.png'));
execFileSync(python, [path.join(root,'scripts/check-cinema.py'),out], {stdio:'inherit'});
console.log('PPTX: '+validated.finalPath);console.log('Ready: '+out);
