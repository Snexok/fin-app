# Сборка презентации-истории

## Канонические файлы

Готовые экспорты находятся в `output/trailer/`:

- `mozhno-story.pdf` - PDF со слайдами в виде изображений, без заметок.
- `mozhno-story-final.pptx` - редактируемый PPTX с текстом, таблицей и заметками.

В презентации 11 слайдов: обложка, 8 сцен, пример расчета и 15-секундная версия. `output/trailer/storyboard.png` показывает раскадровку, а `output/trailer/presentation-slides/` содержит PNG-превью.

## Команды

Из корня репозитория:

```sh
./scripts/story.sh check
./scripts/story.sh build
```

`check` проверяет финальные файлы: 11 слайдов и страниц PDF, порядок слайдов, привязку заметок, редактируемую таблицу, арифметику примера и совпадение PDF с PNG. Это автоматические проверки, визуальный просмотр в PowerPoint выполняется отдельно.

`build` создает новую сборку в `.build/story-build-XXXXXX/export/` и проверяет ее. Путь появится в терминале. Готовые файлы в `output/trailer/` остаются без изменений. Для проверки отдельной сборки: `./scripts/story.sh check .build/story-build-XXXXXX/export`.

После правок сравните новую презентацию с готовой версией. Если принимаете изменения, скопируйте PDF, PPTX и каталог `presentation-slides` из новой сборки в `output/trailer/`. Результат ручного редактирования PPTX автоматически не переносится в исходник.

## Источник и материалы

Исходник перенесен из `.build/story.mjs` в `scripts/build-story.mjs`. В нем находятся содержание, камера и звук. Для визуального источника используются `output/trailer/storyboard.png` и `output/assets/09-engine.png`. Расширенный storyboard/playbook: `output/trailer/entertainment-playbook.md`.

Проверка закрепляет порядок слайдов и суммы утвержденного примера в `scripts/check-story.py`. Если сценарий или суммы меняются намеренно, пересмотрите эти ожидания вместе с исходником. Воспроизводится содержание и внешний вид, служебные идентификаторы внутри PPTX могут отличаться между сборками.

## Runtime

По умолчанию launcher использует:

```text
${HOME}/.cache/codex-runtimes/codex-primary-runtime/dependencies
```

Для другого расположения задайте `STORY_RUNTIME_DIR`. Skill presentations берется из:

```text
${HOME}/.codex/plugins/cache/openai-primary-runtime/presentations/26.909.12148/skills/presentations
```

Для переопределения задайте `STORY_SKILL_DIR`. Отдельная установка пакетов через npm на этом хосте не требуется. Для воспроизводимого рендера нужен указанный runtime и доступный шрифт Arial.

## Границы материалов

Презентация показывает концепт будущего продукта. Камера, звук и переходы описаны в заметках PowerPoint. Видео и звуковые дорожки пока не созданы. Исследовательский пакет на 16 слайдов находится отдельно: `research/README.md` и `output/mozhno-research-playbook.pptx`.
