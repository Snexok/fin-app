"""Check the story package, including its illustrative arithmetic and paired PDF."""
from datetime import date
import json
import os
from pathlib import Path
import posixpath
import re
import subprocess
import sys
import tempfile
from xml.etree import ElementTree as ET
from zipfile import ZipFile

import pypdfium2 as pdfium
from PIL import Image, ImageChops, ImageStat

ROOT = Path(__file__).resolve().parents[1]
NS = {
    'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
    'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
}
TITLES = ['Можно?', 'Это любовь', 'В голове уже клип', 'Вход без приглашения',
          'Маленькая пауза', 'Вопрос по делу', 'Вот что останется',
          'Решение за ней', 'Можно?', 'Пример за кадром', 'Та же история за 15 секунд']


def require(condition, message):
    if not condition:
        raise ValueError(message)


def content(element):
    return ' '.join(element.itertext()) if element is not None else ''


def text(element):
    return ' '.join(content(t) for t in element.findall('.//a:t', NS))


def relationships(package, part):
    folder, filename = posixpath.split(part)
    tree = ET.fromstring(package.read(f'{folder}/_rels/{filename}.rels'))
    result = {}
    for relation in tree:
        target = posixpath.normpath(posixpath.join(folder, relation.attrib['Target'])).lstrip('/')
        result[relation.attrib['Id']] = (relation.attrib['Type'], target)
    return result


def main():
    directory = Path(sys.argv[1]).resolve()
    deck = directory / 'mozhno-story-final.pptx'
    skill = Path(os.environ['STORY_SKILL_DIR']) / 'container_tools'
    (ROOT / '.build').mkdir(exist_ok=True)
    receipt = Path(tempfile.mkdtemp(prefix='story-check-', dir=ROOT / '.build'))
    for validator, flags in [
        ('inspect_presentation_package_integrity.py', []),
        ('inspect_presentation_layout_geometry.py', [
            '--fail-on-findings', '--expected-slide-count', '11',
            '--expected-slide-size-emu', '12192000,6858000',
            '--require-native-table-slide', '10', '--validate-heading-fit',
            '--approved-font-family', 'Arial']),
    ]:
        result = subprocess.run([sys.executable, str(skill / validator), str(deck), *flags],
                                capture_output=True, text=True)
        (receipt / validator.replace('.py', '.json')).write_text(result.stdout)
        require(result.returncode == 0, f'{validator}: {result.stdout} {result.stderr}')

    with ZipFile(deck) as package:
        require(package.testzip() is None, 'Corrupted PPTX ZIP member')
        presentation = ET.fromstring(package.read('ppt/presentation.xml'))
        refs = relationships(package, 'ppt/presentation.xml')
        slides = [refs[e.attrib[f'{{{NS["r"]}}}id']][1]
                  for e in presentation.findall('p:sldIdLst/p:sldId', NS)]
        require(len(slides) == 11, 'Expected 11 slides')
        notes_seen = set()
        texts = []
        for i, part in enumerate(slides):
            tree = ET.fromstring(package.read(part))
            slide_text = text(tree)
            texts.append(slide_text)
            require(TITLES[i] in slide_text, f'Slide {i+1}: title or order mismatch')
            note_parts = [target for kind, target in relationships(package, part).values()
                          if kind.endswith('/notesSlide')]
            require(len(note_parts) == 1, f'Slide {i+1}: missing or duplicated notes')
            note_part = note_parts[0]
            require(note_part not in notes_seen, f'Slide {i+1}: reused notes')
            notes_seen.add(note_part)
            note_text = text(ET.fromstring(package.read(note_part)))
            require('Числа иллюстративные' in note_text, f'Slide {i+1}: missing disclosure')
            require('entertainment-playbook.md' in note_text, f'Slide {i+1}: missing source')
            note_slide = [target for kind, target in relationships(package, note_part).values()
                          if kind.endswith('/slide')]
            require(note_slide == [part], f'Slide {i+1}: notes point to another slide')
            if i == 9:
                tables = tree.findall('.//a:tbl', NS)
                require(len(tables) == 1, 'Slide 10: expected one editable table')
                rows = tables[0].findall('a:tr', NS)
                amounts = []
                for row in rows:
                    cells = row.findall('a:tc', NS)
                    require(len(cells) == 2, 'Slide 10: expected two columns')
                    amount = re.sub(r'[\s₽]', '', text(cells[1])).replace('−', '-')
                    require(re.fullmatch(r'-?\d+', amount), 'Unrecognized amount in slide 10')
                    amounts.append(int(amount))
                require(amounts == [120000, -45000, -30000, -18000, 27000, -12000, 15000],
                        'Slide 10: illustrative amounts changed; review the story contract')
                require(sum(amounts[:4]) == amounts[4], 'Incorrect amount before purchase')
                require(amounts[4] + amounts[5] == amounts[6], 'Incorrect amount after purchase')
                days = (date(2026, 9, 25) - date(2026, 9, 12)).days + 1
                daily, remainder = divmod(amounts[6], days)
                require((days, daily, remainder) == (14, 1071, 6), 'Incorrect daily calculation')
        require('15 000 ₽' in texts[6] and '1 071 ₽' in texts[6], 'Scene result differs from table')
        require('Иллюстративные данные' in texts[9], 'Slide 10: missing visible disclosure')
        require('Продукт в разработке' in texts[0], 'Cover: missing concept status')

    errors = []
    with pdfium.PdfDocument(directory / 'mozhno-story.pdf') as pdf:
        require(len(pdf) == 11, 'Expected 11 PDF pages')
        previews = list((directory / 'presentation-slides').glob('slide-*.png'))
        require(len(previews) == 11, 'Expected 11 slide previews')
        for i, page in enumerate(pdf):
            require(page.get_size() == (960, 540), f'PDF page {i+1}: wrong dimensions')
            # Render the complete PDF page, catching shifted/cropped/swapped images too.
            page_image = page.render(scale=2).to_pil().convert('RGB')
            with Image.open(directory / f'presentation-slides/slide-{i+1:02}.png') as image:
                require(image.size == (1920, 1080), f'Preview {i+1}: wrong dimensions')
                diff = ImageChops.difference(page_image, image.convert('RGB'))
                error = max(ImageStat.Stat(diff).mean)
                require(error < 3, f'PDF page {i+1}: differs from PNG (mean error {error:.2f})')
                errors.append(round(error, 4))

    report = {'status': 'pass', 'slides': 11, 'notes': 11, 'pdf_pages': 11,
              'illustration': {'before': 27000, 'purchase': 12000, 'after': 15000,
                               'days': 14, 'daily': 1071, 'remainder': 6},
              'pdf_png_mean_errors': errors,
              'limitation': 'Automated checks do not prove native PowerPoint rendering or visual text fit.'}
    (receipt / 'story.json').write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(f'PASS: 11 slides, 11 notes, 11 PDF pages, arithmetic and PDF/PNG match. Report: {receipt}')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError) as error:
        sys.exit(f'FAIL: {error}')
