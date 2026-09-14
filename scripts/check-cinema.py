"""Check the generated eight-slide cinema presentation package."""
from datetime import date
import json
from pathlib import Path
import posixpath
import re
import sys
import tempfile
from xml.etree import ElementTree as ET
from zipfile import BadZipFile, ZipFile

import pypdfium2 as pdfium
from PIL import Image, ImageChops, ImageStat


ROOT = Path(__file__).resolve().parents[1]
NS = {
    'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
    'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
}
FULL_FRAME = (0, 0, 12192000, 6858000)
ILLUSTRATIVE_AMOUNTS = [120000, -45000, -30000, -18000, 27000, -12000, 15000]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def content(element):
    return ' '.join(element.itertext()) if element is not None else ''


def text(element):
    return ' '.join(content(node) for node in element.findall('.//a:t', NS))


def relationships(package, part):
    folder, filename = posixpath.split(part)
    tree = ET.fromstring(package.read(f'{folder}/_rels/{filename}.rels'))
    result = {}
    for relation in tree:
        target = posixpath.normpath(posixpath.join(folder, relation.attrib['Target'])).lstrip('/')
        result[relation.attrib['Id']] = (relation.attrib['Type'], target)
    return result


def image_geometry(picture):
    transform = picture.find('p:spPr/a:xfrm', NS)
    require(transform is not None, 'Image has no transform')
    offset = transform.find('a:off', NS)
    extent = transform.find('a:ext', NS)
    require(offset is not None and extent is not None, 'Image has incomplete transform')
    return (int(offset.attrib['x']), int(offset.attrib['y']),
            int(extent.attrib['cx']), int(extent.attrib['cy']))


def check_full_frame_image(slide, number):
    pictures = slide.findall('.//p:pic', NS)
    require(any(image_geometry(picture) == FULL_FRAME for picture in pictures),
            f'Slide {number}: missing 16:9 full-frame image')


def check_editable_text(slide, number):
    text_shapes = slide.findall('.//p:sp', NS)
    require(any(shape.find('p:txBody', NS) is not None and text(shape).strip()
                for shape in text_shapes),
            f'Slide {number}: missing an editable text shape')


def integer_amount(cell, slide_number):
    value = re.sub(r'[\s₽]', '', text(cell)).replace('−', '-')
    require(re.fullmatch(r'-?\d+', value) is not None,
            f'Slide {slide_number}: invalid table amount {value!r}')
    return int(value)


def check_table(slide):
    tables = slide.findall('.//a:tbl', NS)
    require(len(tables) == 1, 'Slide 8: expected one editable native table')
    amounts = []
    for row in tables[0].findall('a:tr', NS):
        cells = row.findall('a:tc', NS)
        require(len(cells) == 2, 'Slide 8: expected two table columns')
        amounts.append(integer_amount(cells[1], 8))
    require(amounts == ILLUSTRATIVE_AMOUNTS,
            'Slide 8: illustrative source values changed')
    require(sum(amounts[:4]) == amounts[4], 'Slide 8: free amount total is incorrect')
    require(amounts[4] + amounts[5] == amounts[6], 'Slide 8: after-purchase total is incorrect')
    days = (date(2026, 9, 25) - date(2026, 9, 12)).days + 1
    daily, remainder = divmod(amounts[6], days)
    require((days, daily, remainder) == (14, 1071, 6),
            'Slide 8: 14-day daily amount or remainder is incorrect')


def check_presentation(deck):
    with ZipFile(deck) as package:
        require(package.testzip() is None, 'Corrupted PPTX ZIP member')
        presentation = ET.fromstring(package.read('ppt/presentation.xml'))
        refs = relationships(package, 'ppt/presentation.xml')
        slides = [refs[slide_id.attrib[f'{{{NS["r"]}}}id']][1]
                  for slide_id in presentation.findall('p:sldIdLst/p:sldId', NS)]
        require(len(slides) == 8, 'Expected 8 slides')

        notes_seen = set()
        slide_texts = []
        for number, part in enumerate(slides, start=1):
            slide = ET.fromstring(package.read(part))
            slide_text = text(slide)
            slide_texts.append(slide_text)
            check_full_frame_image(slide, number)
            check_editable_text(slide, number)

            note_parts = [target for kind, target in relationships(package, part).values()
                          if kind.endswith('/notesSlide')]
            require(len(note_parts) == 1, f'Slide {number}: missing or duplicated notes')
            note_part = note_parts[0]
            require(note_part not in notes_seen, f'Slide {number}: reused notes')
            notes_seen.add(note_part)
            note = ET.fromstring(package.read(note_part))
            note_text = text(note)
            require('README.md' in note_text and 'entertainment-playbook.md' in note_text,
                    f'Slide {number}: notes do not cite README and entertainment playbook')
            note_slides = [target for kind, target in relationships(package, note_part).values()
                           if kind.endswith('/slide')]
            require(note_slides == [part], f'Slide {number}: notes link to another slide')

            if number == 8:
                check_table(slide)

        require('Концепт' in slide_texts[0], 'Slide 1: missing visible concept status')
        require('Концепт будущего продукта' in slide_texts[6],
                'Slide 7: missing visible concept status')
        require('15 000 ₽' in slide_texts[4] and 'необязательные траты' in slide_texts[4],
                'Slide 5: displayed result differs from the table or loses its scope')
        require(all(value in slide_texts[7] for value in ['14 дней', '1 071 ₽', 'остаток 6 ₽']),
                'Slide 8: displayed daily calculation differs from the table')
        require('Пример расчета' in slide_texts[4],
                'Slide 5: missing visible illustrative-calculation status')
        require('Иллюстративные данные' in slide_texts[7],
                'Slide 8: missing visible illustrative-data status')

    return len(notes_seen)


def check_pdf_and_pngs(directory):
    pdf_path = directory / 'mozhno-cinema.pdf'
    png_dir = directory / 'slides'
    expected_pngs = [png_dir / f'slide-{number:02}.png' for number in range(1, 9)]
    require(all(path.is_file() for path in expected_pngs),
            'Expected slides/slide-01.png through slide-08.png')
    require(sorted(png_dir.glob('slide-*.png')) == expected_pngs,
            'Unexpected or missing slide PNG previews')

    errors = []
    with pdfium.PdfDocument(pdf_path) as pdf:
        require(len(pdf) == 8, 'Expected 8 PDF pages')
        for number, page in enumerate(pdf, start=1):
            require(page.get_size() == (960, 540),
                    f'PDF page {number}: expected 960x540')
            rendered = page.render(scale=2).to_pil().convert('RGB')
            require(rendered.size == (1920, 1080),
                    f'PDF page {number}: render is not 1920x1080')
            with Image.open(expected_pngs[number - 1]) as preview:
                require(preview.size == (1920, 1080),
                        f'PNG {number}: expected 1920x1080')
                difference = ImageChops.difference(rendered, preview.convert('RGB'))
                error = max(ImageStat.Stat(difference).mean)
                require(error < 3, f'PDF page {number}: differs from PNG (mean {error:.2f})')
                errors.append(round(error, 4))
    return errors


def main():
    require(len(sys.argv) == 2, 'Usage: check-cinema.py OUTPUT_DIRECTORY')
    directory = Path(sys.argv[1]).resolve()
    require(directory.is_dir(), f'Output directory does not exist: {directory}')
    deck = directory / 'mozhno-cinema.pptx'
    require(deck.is_file(), f'PPTX does not exist: {deck}')

    (ROOT / '.build').mkdir(exist_ok=True)
    receipt = Path(tempfile.mkdtemp(prefix='cinema-check-', dir=ROOT / '.build'))
    notes = check_presentation(deck)
    errors = check_pdf_and_pngs(directory)
    (receipt / 'cinema.json').write_text(json.dumps({
        'status': 'pass', 'slides': 8, 'notes': notes, 'pdf_pages': 8,
        'pdf_png_mean_errors': errors,
    }, ensure_ascii=False, indent=2))
    print(f'PASS: 8 slides, 8 notes, PDF and PNG previews match. Report: {receipt}')


if __name__ == '__main__':
    try:
        main()
    except (BadZipFile, ET.ParseError, OSError, KeyError, ValueError) as error:
        sys.exit(f'FAIL: {error}')
