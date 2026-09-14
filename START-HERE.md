# Можно? Наушники и незваные гости

Презентация рассказывает историю покупки наушников. Новая версия содержит 8 слайдов с иллюстрациями на весь экран: семь сюжетных кадров и подробный расчет. Продукт находится на стадии гипотезы, суммы приведены для иллюстрации.

Откройте готовые файлы:

- [PDF](output/trailer-cinema/mozhno-cinema.pdf) - версия для просмотра, слайды сохранены как изображения, без заметок.
- [PPTX](output/trailer-cinema/mozhno-cinema.pptx) - редактируемые тексты и таблица, с заметками.
- [Все слайды на одном изображении](output/trailer-cinema/overview.png).
- [Рендер слайдов](output/trailer-cinema/slides/) - PNG-превью 8 слайдов.

Проверка готовых файлов:

```sh
./scripts/story.sh check-cinema
```

Пересборка создает новые файлы в `.build/cinema-XXXXXX/export/`. Готовые экспорты в `output/trailer-cinema/` остаются без изменений:

```sh
./scripts/story.sh cinema
```

Сценарий, камера и звук описаны в [исходнике презентации](scripts/build-cinema.mjs). Подробные правила постановки находятся в [сценарии трейлера](output/trailer/entertainment-playbook.md).

Прежняя версия из 11 слайдов сохранена: [PDF](output/trailer/mozhno-story.pdf), [PPTX](output/trailer/mozhno-story-final.pptx). Для нее по-прежнему работают команды `./scripts/story.sh build` и `./scripts/story.sh check`.

Исследование аналогов и прежняя презентация из 16 слайдов: [материалы исследования](research/README.md) и [PowerPoint](output/mozhno-research-playbook.pptx).

В заметках PowerPoint находятся указания для камеры, звука и переходов. Видео и звуковые дорожки пока не созданы. Для сборки нужны комплект зависимостей Codex и шрифт Arial. Подробности: [инструкция по сборке](docs/presentation-build.md).
