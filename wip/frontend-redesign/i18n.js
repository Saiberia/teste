/* Interface strings + locale helpers (plurals via Intl.PluralRules, 24-hour dates via Intl.DateTimeFormat).
   Add a language by adding a dictionary with the same keys. A plural entry is an object
   {one, few, many, other} ({one, other} is enough for English); "{n}" is replaced by the number. */
(function () {
  const ru = {
    app_tagline: "Слушает встречу и решает задачи, которые вы ставите голосом",
    need_token: "Откройте приложение по ссылке с токеном доступа.",
    close: "Закрыть", cancel: "Отмена", ok: "OK", save: "Сохранить", saved: "Сохранено", delete: "Удалить", error: "Ошибка",
    loading: "Загрузка…", confirm_title: "Подтвердите действие", copy: "Копировать", copied: "Скопировано",
    copy_failed: "Не удалось скопировать", send: "Отправить", open: "Открыть", back: "Назад", more: "Ещё", edit: "Изменить",
    retry_soon: "повторю позже", limit: "Достигнут лимит ответов на встречу", menu: "Меню",

    nav_label: "Разделы", nav_live: "Встреча", nav_meetings: "История встреч", nav_knowledge: "Память: база знаний",
    nav_ai: "Проверка ИИ", nav_settings: "Настройки",
    navs_live: "Встреча", navs_meetings: "История", navs_knowledge: "Память", navs_ai: "Проверка", navs_settings: "Настройки",

    ai_on: "ИИ: {name}", ai_sim: "ИИ: симуляция", ai_offline: "ИИ: офлайн — только контекст", ai_error: "ИИ: нет связи",
    ai_openai: "OpenAI-совместимый", ai_tip_offline: "ИИ не подключён: ассистент соберёт контекст, но не напишет ответ. Подключите ИИ в настройках.",

    live_title_ph: "Название встречи", default_title: "Встреча", template: "Шаблон отчёта",
    tpl_locked: "Шаблон можно сменить в отчёте после встречи",
    rec_on: "Запись", rec_paused: "Пауза", rec_off: "Звук не записывается", rec_none: "Встреча не начата",
    meeting_running: "Идёт встреча", level_me: "Вы", level_others: "Собес.", level_me_full: "Ваш микрофон",
    level_others_full: "Собеседники (системный звук)", level_off: "не записывается",
    shield_on: "Скрыто от показа экрана", shield_on_tip: "Плавающая панель не видна при демонстрации экрана.",
    shield_off: "Может быть видно", shield_off_tip: "Панель может быть видна при показе экрана: здесь скрытие не поддерживается или выключено в настройках. Показывайте отдельное окно, а не весь экран.",
    record: "Записывать звук", stop_record: "Остановить запись", pause: "Пауза", resume: "Продолжить",
    finish: "Завершить и собрать итог", finish_short: "Завершить", finishing: "Собираю итог…", recording: "Идёт запись",
    asr_off_tip: "Распознавание речи выключено в настройках", processing: "Обрабатываю встречу…",

    start_title: "Новая встреча",
    start_body: "Ассистент слушает разговор, выполняет ваши задачи и собирает итог. Участникам ничего не отправляется.",
    consent: "Участники предупреждены о записи",
    consent_msg: "Коллеги, я веду заметки встречи с помощью ИИ-ассистента Recapper. Если кто-то против записи — скажите, я остановлю.",
    copy_consent_msg: "Скопировать сообщение", start_meeting: "Начать встречу", start_and_record: "Начать и записывать звук",
    start_hint: "Без записи звука реплики можно вводить вручную — в колонке «Расшифровка».",
    consent_needed: "Подтвердите, что участники предупреждены о записи.",
    consent_dialog_title: "Участники знают о записи?",
    consent_dialog_body: "Предупредите участников, что встреча записывается. Сообщение для чата встречи уже скопировано:",
    consent_yes: "Да, записывать",

    seg_tasks: "Задачи и ответы", seg_summary: "Живой итог", mtab_tasks: "Задачи", mtab_heard: "Прозвучало",
    mtab_transcript: "Расшифровка", sections_tabs: "Разделы встречи",

    empty_title: "Скажите «Ассистент, …» — задача появится здесь",
    empty_body: "Ассистент слышит команды в разговоре и отвечает только вам. Попробуйте:",
    ex1: "Ассистент, допиши механику монетизации: конверсия из Самоката в Купер",
    ex2: "Ассистент, что мы решили про онбординг на прошлой неделе?",
    ex3: "Ассистент, найди в интернете тарифы конкурентов",
    empty_hint: "Нажмите на пример, чтобы вставить его в поле ввода.", wake_words: "Слова-обращения:",

    ask_ph: "Попросите ассистента или скажите «Ассистент, …»", composer_hint: "Enter — отправить · Shift+Enter — новая строка",
    quick_actions: "Быстрые действия", new_answer: "Новый ответ",
    qa_catch_up: "Догнать (1 мин)", qa_summary: "Итог сейчас", qa_followups: "Что спросить", qa_actions: "Поручения", qa_topics: "Темы",
    quick_action: "Быстрое действие",

    by_voice: "Голосом", typed: "Вы написали", from_meeting: "Из обсуждения", task: "Задача", question: "Вопрос",
    possible: "возможно", thinking: "Думаю…", done: "Готово", offline_short: "Офлайн", failed: "Ошибка", cancelled: "Отменено",
    accepted: "Принято:", cancel_cmd: "Отменить", restore: "Вернуть",
    step_understood: "Понял задачу", step_memory: "Ищу в прошлых встречах", step_docs: "Ищу в документах",
    step_web: "Ищу в интернете", step_writing: "Пишу ответ", found_none: "ничего не нашёл", found_n: "нашёл {n}",
    trail_memory: "прошлые встречи: {n}", trail_docs: "документы: {n}", trail_web: "интернет",
    long_thinking: "Долго думаю.", check_answer: "Проверьте ответ",
    low_conf_note: "Уверенность низкая: проверьте факты и цифры перед тем, как использовать ответ.",
    assumptions: "Допущения", sources: "Источники", this_meeting: "Эта встреча", past_meeting: "Прошлая встреча",
    confidence: "Уверенность", conf_high: "высокая", conf_medium: "средняя", conf_low: "низкая",
    refine: "Уточнить", refine_ph: "Уточнение к этой задаче…", retry: "Повторить", retry_ai: "Повторить с ИИ",
    copy_task: "Скопировать задачу", offline_title: "Офлайн: ИИ недоступен.",
    offline_body: "Собран только контекст — полный ответ появится, когда ИИ будет подключён.",
    failed_title: "Не удалось получить ответ", in_summary: "В итоге", add_to_summary: "В итог",
    expand: "Развернуть", collapse: "Свернуть", answer: "Ответить", hide: "Скрыть",
    answering_feed: "Отвечаю → в ленте", answered_feed: "Ответ в ленте",
    hidden_n: "Скрытые · {n}", suggestion_hidden: "Подсказка скрыта", item_cancelled: "Задача отменена",

    heard: "Прозвучало на встрече",
    heard_empty: "Когда на встрече прозвучит вопрос или задача, они появятся здесь. Отвечать или нет — решаете вы.",

    transcript: "Расшифровка", transcript_empty: "Здесь появится расшифровка. Включите запись звука или введите реплику вручную.",
    line_ph: "Реплика вручную: «Имя: текст»", add_line: "Добавить", analyze_now: "Проанализировать сейчас",
    command: "команда", to_latest: "К последним", manual_line: "Ввести реплику вручную",

    ls_draft: "Черновик ИИ", ls_refresh: "Обновить итог", ls_brief: "Кратко", ls_actions: "Поручения", ls_topics: "Темы",
    ls_followups: "Что спросить", ls_answers: "Ответы ассистента",
    ls_empty_brief: "Нажмите «Итог сейчас» — здесь появится промежуточный итог.",
    ls_empty_actions: "Нажмите «Поручения», чтобы собрать договорённости.",
    ls_empty_answers: "Ответы на ваши задачи попадают сюда автоматически.",
    ls_remove: "Убрать из итога", ls_removed: "Убрано из итога: {n}", ls_restore_all: "Вернуть все",

    capture_missing: "Модуль записи звука не загружен", capture_failed: "Не удалось начать запись",
    report_ready: "Итог встречи готов", open_report: "Открыть отчёт",

    tab_report: "Отчёт", tab_answers: "Ответы ассистента", tab_transcript: "Расшифровка", tab_people: "Участники", tab_chat: "Чат",
    brief: "Кратко", decisions: "Решения", action_items: "Поручения",
    ai_count: { one: "{n} поручение", few: "{n} поручения", many: "{n} поручений", other: "{n} поручения" },
    ai_unassigned: "{n} без ответственного", owner_ph: "Не назначен", due_ph: "Срок?", owner: "Ответственный", due: "Срок",
    add_action: "Добавить поручение", done_label: "Выполнено", delete_action: "Удалить поручение", action_text: "Текст поручения",
    decisions_ph: "По одному решению на строку", edited_by_you: "Отредактировано вами",
    draft_ai: "Черновик ИИ", reviewed: "Проверено", mark_reviewed: "Всё проверено", rebuild: "Пересобрать",
    rebuild_title: "Пересобрать отчёт?",
    rebuild_confirm: "Пересобрать отчёт по шаблону «{name}»? «Кратко», решения, поручения и разделы будут собраны заново — ваши правки в них пропадут. Ответы ассистента сохранятся.",
    rebuilt: "Отчёт пересобран по шаблону «{name}»", export: "Экспорт", export_md: "Markdown (.md)", export_docx: "Word (.docx)",
    export_json: "JSON", export_copy: "Скопировать как текст",
    participants_n: { one: "{n} участник", few: "{n} участника", many: "{n} участников", other: "{n} участника" },
    filter_all: "Все", filter_voice: "Голосом", filter_typed: "Написано", filter_meeting: "Из обсуждения",
    filter_label: "Фильтр ответов", no_answers: "Ответов нет.", tx_search_ph: "Поиск по расшифровке", all_speakers: "Все спикеры",
    no_matches: "Ничего не найдено.",
    lines_n: { one: "{n} реплика", few: "{n} реплики", many: "{n} реплик", other: "{n} реплики" },
    first_line: "первая:", rename: "Переименовать", name: "Имя",
    renamed: { one: "Переименовано в {n} месте", few: "Переименовано в {n} местах", many: "Переименовано в {n} местах", other: "Переименовано в {n} местах" },
    no_transcript_stored: "Расшифровка не хранится (см. «Данные и приватность» в настройках).",
    no_people: "Спикеры не определены.", consent_noted_yes: "Участники предупреждены", consent_noted_no: "Предупреждение участников не отмечено",
    empty_recap: "Итог пуст.", sections: "Разделы шаблона", no_decisions: "Решений не прозвучало.",
    no_actions: "Поручений не прозвучало.", hidden_suggestions: "Скрытые подсказки",

    chat_title: "Спросите про встречу", scope_label: "Где искать ответ", scope_meeting: "Эта встреча", scope_all: "Все встречи",
    chat_ph: "Вопрос о встрече…", chat_ph_all: "Вопрос по всем встречам…",
    starter1: "Какие решения приняли?", starter2: "Что осталось нерешённым?", starter3: "Составь письмо-итог участникам",
    chat_empty: "Ответ опирается на расшифровку, итог и ответы ассистента. В режиме «Все встречи» — на память о прошлых встречах.",
    you: "Вы", assistant: "Ассистент",

    meetings_title: "Встречи", new_meeting: "Новая встреча", upload_btn: "Загрузить", search_ph: "Поиск по встречам и памяти",
    search: "Найти", memory_answer: "Ответ по памяти", found_in_meetings: "Найдено во встречах",
    g_today: "Сегодня", g_yesterday: "Вчера", g_week: "На этой неделе", today_l: "сегодня", yesterday_l: "вчера",
    no_meetings_title: "Здесь появятся ваши встречи", no_meetings_body: "Начните запись или загрузите расшифровку или аудио.",
    answers_n: { one: "{n} ответ", few: "{n} ответа", many: "{n} ответов", other: "{n} ответа" },
    delete_confirm: "Удалить встречу «{title}» безвозвратно?", deleted: "Встреча удалена", delete_meeting: "Удалить встречу",
    upload: "Загрузить расшифровку или запись", upload_text_ph: "Или вставьте расшифровку: «Имя: реплика», VTT или SRT",
    upload_file: "Файл (.txt, .vtt, .srt или аудио)", questions_ph: "Свои вопросы, по одному на строку (необязательно)",
    process: "Обработать", no_title_match: "Нет встреч с таким названием.", consent_audio: "Участники согласились на запись (для аудио)",

    knowledge_title: "Память: база знаний",
    knowledge_hint: "Материалы компании: ассистент опирается на них в ответах и указывает источник.",
    upload_kb: "Загрузить файл", no_kb_title: "Загрузите документы — ассистент будет опираться на них в ответах",
    no_kb: "Форматы .md, .txt и .csv, до 2 МБ.", kb_size: "{kb} КБ", choose_file: "Выбрать файл", no_file: "Файл не выбран",
    delete_file: "Удалить файл {name}",

    settings_title: "Настройки", secret_set: "задан", secret_empty: "не задан", secret_ph: "Вставьте ключ, чтобы изменить",
    reset: "Сбросить", restart_note: "Применится к следующей записи", unsaved: "Есть несохранённые изменения",
    no_changes: "Изменений нет", show_onboarding: "Показать знакомство снова", misc_group: "Прочее",

    ai_title: "Проверка ИИ: что спросили и что ответила модель",
    ai_hint: "Каждый запрос к ИИ перехватывается и проверяется по контракту. Так видно, справится ли другая модель.",
    ai_provider: "Провайдер", ai_calls: "Вызовов", ai_issues: "С нарушениями", ai_none: "Вызовов пока не было.",
    latency: "мс", issues: "Нарушения", prompt: "Запрос", output: "Ответ",

    onb_title: "Знакомство с Recapper", onb_step: "Шаг {i} из {n}", onb_skip: "Пропустить", onb_next: "Далее", onb_back: "Назад",
    onb_done: "Готово",
    onb1_title: "Звук",
    onb1_body: "Recapper записывает ваш микрофон и звук собеседников (системный звук или вкладку браузера). Проверьте, что микрофон слышно.",
    onb1_test: "Проверить микрофон", onb1_ok: "Звук есть", onb1_quiet: "Скажите что-нибудь…", onb1_fail: "Нет доступа к микрофону: {msg}",
    onb1_nocap: "Запись звука здесь недоступна — реплики можно вводить вручную.",
    onb2_title: "ИИ", onb2_body: "Ассистент отвечает с помощью подключённой модели. Без ИИ он собирает только контекст: цитаты, документы, прошлые встречи.",
    onb2_check: "Проверить соединение", onb2_settings: "Настройки ИИ",
    onb3_title: "Голосовая команда", onb3_body: "Во время встречи скажите вслух:", onb3_example: "«Ассистент, найди тарифы конкурентов»",
    onb3_after: "Задача появится в ленте, ответ увидите только вы. Слова-обращения из настроек:",
    onb4_title: "Согласие и приватность",
    onb4_body: "Recapper записывает звук на вашем компьютере, бот во встречу не заходит, итог никому не рассылается. Предупредите участников о записи:",

    panel_no_session: "Нет активной встречи", panel_no_session_body: "Начните встречу в основном окне — панель подключится сама.",
    open_main: "Открыть основное окно", hide_panel: "Скрыть панель", panel_hint: "{key} — показать или скрыть панель",
    heard_short: "Прозвучало · {n}", prev: "Предыдущий ответ", next: "Следующий ответ", latest: "К последнему",
    panel_empty: "Ответы появятся здесь. Задайте вопрос или скажите «Ассистент, …».",

    sr_answer_ready: "Готов ответ: {title}", sr_assist_ready: "Готово: {title}",
    dur_m: "{m} мин", dur_hm: "{h} ч {m} мин", dur_lt1: "меньше минуты", dur_s: "{s} с",
  };

  const en = {
    app_tagline: "Listens to your meeting and solves the tasks you give it by voice",
    need_token: "Open the app using the link with the access token.",
    close: "Close", cancel: "Cancel", ok: "OK", save: "Save", saved: "Saved", delete: "Delete", error: "Error",
    loading: "Loading…", confirm_title: "Please confirm", copy: "Copy", copied: "Copied", copy_failed: "Could not copy",
    send: "Send", open: "Open", back: "Back", more: "More", edit: "Edit", retry_soon: "will retry",
    limit: "Answer limit for this meeting reached", menu: "Menu",

    nav_label: "Sections", nav_live: "Meeting", nav_meetings: "Meeting history", nav_knowledge: "Memory: knowledge base",
    nav_ai: "AI check", nav_settings: "Settings",
    navs_live: "Meeting", navs_meetings: "History", navs_knowledge: "Memory", navs_ai: "AI check", navs_settings: "Settings",

    ai_on: "AI: {name}", ai_sim: "AI: simulated", ai_offline: "AI: offline — context only", ai_error: "AI: no connection",
    ai_openai: "OpenAI-compatible", ai_tip_offline: "No AI connected: the assistant gathers context but does not write answers. Connect an AI in Settings.",

    live_title_ph: "Meeting title", default_title: "Meeting", template: "Report template",
    tpl_locked: "The template can be changed in the report after the meeting",
    rec_on: "Recording", rec_paused: "Paused", rec_off: "Audio is not recorded", rec_none: "Meeting not started",
    meeting_running: "Meeting in progress", level_me: "You", level_others: "Others", level_me_full: "Your microphone",
    level_others_full: "Other participants (system audio)", level_off: "not captured",
    shield_on: "Hidden from screen sharing", shield_on_tip: "The floating panel is not visible when you share your screen.",
    shield_off: "May be visible", shield_off_tip: "The panel may be visible while screen sharing: hiding is unsupported here or disabled in Settings. Share a single window rather than the whole screen.",
    record: "Record audio", stop_record: "Stop recording", pause: "Pause", resume: "Resume",
    finish: "Finish and build summary", finish_short: "Finish", finishing: "Building the summary…", recording: "Recording",
    asr_off_tip: "Speech recognition is turned off in Settings", processing: "Processing the meeting…",

    start_title: "New meeting",
    start_body: "The assistant listens, handles your tasks and builds a summary. Nothing is sent to participants.",
    consent: "Participants know they are recorded",
    consent_msg: "Hi all, I am taking meeting notes with the Recapper AI assistant. If anyone objects to recording, say so and I will stop.",
    copy_consent_msg: "Copy message", start_meeting: "Start meeting", start_and_record: "Start and record audio",
    start_hint: "Without audio you can type utterances by hand in the Transcript column.",
    consent_needed: "Confirm that participants know about the recording.",
    consent_dialog_title: "Do participants know?", consent_dialog_body: "Tell participants the meeting is recorded. A message for the meeting chat has been copied:",
    consent_yes: "Yes, record",

    seg_tasks: "Tasks and answers", seg_summary: "Live summary", mtab_tasks: "Tasks", mtab_heard: "Heard",
    mtab_transcript: "Transcript", sections_tabs: "Meeting sections",

    empty_title: "Say “Assistant, …” and the task appears here",
    empty_body: "The assistant hears commands in the conversation and answers only you. Try:",
    ex1: "Assistant, draft the monetisation mechanic: conversion from app A to app B",
    ex2: "Assistant, what did we decide about onboarding last week?",
    ex3: "Assistant, search the web for competitor pricing",
    empty_hint: "Click an example to put it into the input.", wake_words: "Wake words:",

    ask_ph: "Ask the assistant or say “Assistant, …”", composer_hint: "Enter to send · Shift+Enter for a new line",
    quick_actions: "Quick actions", new_answer: "New answer",
    qa_catch_up: "Catch up (1 min)", qa_summary: "Summary now", qa_followups: "What to ask", qa_actions: "Action items", qa_topics: "Topics",
    quick_action: "Quick action",

    by_voice: "By voice", typed: "Typed", from_meeting: "From the discussion", task: "Task", question: "Question",
    possible: "possible", thinking: "Thinking…", done: "Done", offline_short: "Offline", failed: "Error", cancelled: "Cancelled",
    accepted: "Accepted:", cancel_cmd: "Undo", restore: "Restore",
    step_understood: "Understood the task", step_memory: "Searching past meetings", step_docs: "Searching documents",
    step_web: "Searching the web", step_writing: "Writing the answer", found_none: "nothing found", found_n: "found {n}",
    trail_memory: "past meetings: {n}", trail_docs: "documents: {n}", trail_web: "web",
    long_thinking: "Taking a while.", check_answer: "Check this answer",
    low_conf_note: "Low confidence: verify facts and numbers before using this answer.",
    assumptions: "Assumptions", sources: "Sources", this_meeting: "This meeting", past_meeting: "Past meeting",
    confidence: "Confidence", conf_high: "high", conf_medium: "medium", conf_low: "low",
    refine: "Refine", refine_ph: "Follow-up to this task…", retry: "Retry", retry_ai: "Retry with AI",
    copy_task: "Copy task", offline_title: "Offline: AI unavailable.",
    offline_body: "Only context was gathered — the full answer appears once an AI is connected.",
    failed_title: "Could not get an answer", in_summary: "In summary", add_to_summary: "Add to summary",
    expand: "Expand", collapse: "Collapse", answer: "Answer", hide: "Hide",
    answering_feed: "Answering → in the feed", answered_feed: "Answer in the feed",
    hidden_n: "Hidden · {n}", suggestion_hidden: "Suggestion hidden", item_cancelled: "Task cancelled",

    heard: "Heard in the meeting",
    heard_empty: "Questions and tasks from the conversation appear here. You decide whether to answer.",

    transcript: "Transcript", transcript_empty: "The transcript appears here. Record audio or type an utterance by hand.",
    line_ph: "Type an utterance: “Name: text”", add_line: "Add", analyze_now: "Analyse now",
    command: "command", to_latest: "Latest", manual_line: "Type an utterance",

    ls_draft: "AI draft", ls_refresh: "Refresh summary", ls_brief: "Brief", ls_actions: "Action items", ls_topics: "Topics",
    ls_followups: "What to ask", ls_answers: "Assistant answers",
    ls_empty_brief: "Click “Summary now” to get an interim summary here.",
    ls_empty_actions: "Click “Action items” to collect agreements.",
    ls_empty_answers: "Answers to your tasks are added here automatically.",
    ls_remove: "Remove from summary", ls_removed: "Removed from summary: {n}", ls_restore_all: "Restore all",

    capture_missing: "The audio capture module is not loaded", capture_failed: "Could not start recording",
    report_ready: "The meeting summary is ready", open_report: "Open report",

    tab_report: "Report", tab_answers: "Assistant answers", tab_transcript: "Transcript", tab_people: "Participants", tab_chat: "Chat",
    brief: "Brief", decisions: "Decisions", action_items: "Action items",
    ai_count: { one: "{n} action item", other: "{n} action items" },
    ai_unassigned: "{n} unassigned", owner_ph: "Unassigned", due_ph: "Due?", owner: "Owner", due: "Due",
    add_action: "Add action item", done_label: "Done", delete_action: "Delete action item", action_text: "Action item text",
    decisions_ph: "One decision per line", edited_by_you: "Edited by you",
    draft_ai: "AI draft", reviewed: "Reviewed", mark_reviewed: "All reviewed", rebuild: "Rebuild",
    rebuild_title: "Rebuild the report?",
    rebuild_confirm: "Rebuild the report with the “{name}” template? Brief, decisions, action items and sections are rebuilt — your edits there are lost. Assistant answers are kept.",
    rebuilt: "Report rebuilt with “{name}”", export: "Export", export_md: "Markdown (.md)", export_docx: "Word (.docx)",
    export_json: "JSON", export_copy: "Copy as text",
    participants_n: { one: "{n} participant", other: "{n} participants" },
    filter_all: "All", filter_voice: "By voice", filter_typed: "Typed", filter_meeting: "From the discussion",
    filter_label: "Filter answers", no_answers: "No answers.", tx_search_ph: "Search the transcript", all_speakers: "All speakers",
    no_matches: "Nothing found.", lines_n: { one: "{n} line", other: "{n} lines" }, first_line: "first:",
    rename: "Rename", name: "Name", renamed: { one: "Renamed in {n} place", other: "Renamed in {n} places" },
    no_transcript_stored: "The transcript is not stored (see Data and privacy in Settings).",
    no_people: "No speakers detected.", consent_noted_yes: "Participants were told", consent_noted_no: "Participant notice not ticked",
    empty_recap: "The summary is empty.", sections: "Template sections", no_decisions: "No decisions were made.",
    no_actions: "No action items.", hidden_suggestions: "Hidden suggestions",

    chat_title: "Ask about the meeting", scope_label: "Where to look", scope_meeting: "This meeting", scope_all: "All meetings",
    chat_ph: "Question about the meeting…", chat_ph_all: "Question across all meetings…",
    starter1: "What did we decide?", starter2: "What is still open?", starter3: "Draft a follow-up email",
    chat_empty: "Answers use the transcript, summary and assistant answers. “All meetings” uses the memory of past meetings.",
    you: "You", assistant: "Assistant",

    meetings_title: "Meetings", new_meeting: "New meeting", upload_btn: "Upload", search_ph: "Search meetings and memory",
    search: "Search", memory_answer: "Answer from memory", found_in_meetings: "Found in meetings",
    g_today: "Today", g_yesterday: "Yesterday", g_week: "This week", today_l: "today", yesterday_l: "yesterday",
    no_meetings_title: "Your meetings will appear here", no_meetings_body: "Start a recording or upload a transcript or audio.",
    answers_n: { one: "{n} answer", other: "{n} answers" },
    delete_confirm: "Delete the meeting “{title}” permanently?", deleted: "Meeting deleted", delete_meeting: "Delete meeting",
    upload: "Upload a transcript or recording", upload_text_ph: "Or paste a transcript: “Name: text”, VTT or SRT",
    upload_file: "File (.txt, .vtt, .srt or audio)", questions_ph: "Your own questions, one per line (optional)",
    process: "Process", no_title_match: "No meetings with this title.", consent_audio: "Participants agreed to be recorded (for audio)",

    knowledge_title: "Memory: knowledge base",
    knowledge_hint: "Company materials: the assistant relies on them in answers and cites the source.",
    upload_kb: "Upload file", no_kb_title: "Upload documents — the assistant will rely on them",
    no_kb: ".md, .txt and .csv, up to 2 MB.", kb_size: "{kb} KB", choose_file: "Choose file", no_file: "No file chosen",
    delete_file: "Delete file {name}",

    settings_title: "Settings", secret_set: "set", secret_empty: "not set", secret_ph: "Paste a key to change it",
    reset: "Reset", restart_note: "Applies to the next recording", unsaved: "You have unsaved changes",
    no_changes: "No changes", show_onboarding: "Show the introduction again", misc_group: "Other",

    ai_title: "AI check: what was asked and what the model answered",
    ai_hint: "Every AI request is intercepted and checked against its contract, so you can see whether another model copes.",
    ai_provider: "Provider", ai_calls: "Calls", ai_issues: "With issues", ai_none: "No calls yet.",
    latency: "ms", issues: "Issues", prompt: "Request", output: "Response",

    onb_title: "Welcome to Recapper", onb_step: "Step {i} of {n}", onb_skip: "Skip", onb_next: "Next", onb_back: "Back",
    onb_done: "Done",
    onb1_title: "Sound", onb1_body: "Recapper records your microphone and the other participants (system audio or a browser tab). Check that your microphone is heard.",
    onb1_test: "Test microphone", onb1_ok: "Sound detected", onb1_quiet: "Say something…", onb1_fail: "No microphone access: {msg}",
    onb1_nocap: "Audio capture is not available here — you can type utterances by hand.",
    onb2_title: "AI", onb2_body: "The assistant answers with the connected model. Without AI it only gathers context: quotes, documents, past meetings.",
    onb2_check: "Check connection", onb2_settings: "AI settings",
    onb3_title: "Voice command", onb3_body: "During the meeting say out loud:", onb3_example: "“Assistant, find competitor pricing”",
    onb3_after: "The task appears in the feed and only you see the answer. Wake words from Settings:",
    onb4_title: "Consent and privacy",
    onb4_body: "Recapper records audio on your computer; no bot joins the call and nothing is sent to anyone. Tell participants about the recording:",

    panel_no_session: "No active meeting", panel_no_session_body: "Start a meeting in the main window — the panel connects by itself.",
    open_main: "Open the main window", hide_panel: "Hide panel", panel_hint: "{key} — show or hide the panel",
    heard_short: "Heard · {n}", prev: "Previous answer", next: "Next answer", latest: "Latest",
    panel_empty: "Answers appear here. Ask a question or say “Assistant, …”.",

    sr_answer_ready: "Answer ready: {title}", sr_assist_ready: "Done: {title}",
    dur_m: "{m} min", dur_hm: "{h} h {m} min", dur_lt1: "under a minute", dur_s: "{s} s",
  };

  const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] !== undefined ? vars[k] : m));
  const toDate = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const d = v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) ? null : d;
  };
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayDiff = (d, now) => Math.round((midnight(now) - midnight(d)) / 86400000);
  const pad = (n) => String(n).padStart(2, "0");

  const I = {
    dicts: { ru, en },
    lang: "ru",
    setLang(l) { this.lang = this.dicts[l] ? l : "ru"; this._pr = null; },
    locale() { return this.lang === "en" ? "en-GB" : "ru-RU"; },
    t(key, vars) {
      const d = this.dicts[this.lang] || ru;
      let s = d[key] !== undefined ? d[key] : ru[key] !== undefined ? ru[key] : key;
      if (s && typeof s === "object") s = s.other;
      return vars ? fill(s, vars) : s;
    },
    tn(key, n, vars) {
      const d = this.dicts[this.lang] || ru;
      const forms = d[key] !== undefined ? d[key] : ru[key];
      const all = Object.assign({ n: this.num(n) }, vars || {});
      if (!forms || typeof forms !== "object") return fill(forms === undefined ? key : forms, all);
      if (!this._pr) this._pr = new Intl.PluralRules(this.locale());
      const s = forms[this._pr.select(n)] || forms.other || forms.many || forms.one;
      return fill(s, all);
    },
    num(n, opts) { return new Intl.NumberFormat(this.locale(), opts).format(n); },
    date(v, opts) { const d = toDate(v); return d ? new Intl.DateTimeFormat(this.locale(), opts).format(d) : ""; },
    time(v) { return this.date(v, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); },
    /** "сегодня, 14:05" · "вчера, 14:05" · "29 сент., 14:05" · "29 сент. 2025 г., 14:05" */
    when(v) {
      const d = toDate(v); if (!d) return "";
      const now = new Date(), days = dayDiff(d, now), time = this.time(d);
      if (days === 0) return this.t("today_l") + ", " + time;
      if (days === 1) return this.t("yesterday_l") + ", " + time;
      const opts = d.getFullYear() === now.getFullYear() ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" };
      return this.date(d, opts) + ", " + time;
    },
    /** History group: Сегодня / Вчера / На этой неделе / «Сентябрь 2026 г.» */
    group(v) {
      const d = toDate(v); if (!d) return { key: "?", label: "—" };
      const now = new Date(), days = dayDiff(d, now);
      if (days <= 0) return { key: "today", label: this.t("g_today") };
      if (days === 1) return { key: "yesterday", label: this.t("g_yesterday") };
      const monday = midnight(now); monday.setDate(monday.getDate() - ((now.getDay() + 6) % 7));
      if (d >= monday) return { key: "week", label: this.t("g_week") };
      const label = this.date(d, { month: "long", year: "numeric" });
      return { key: d.getFullYear() + "-" + d.getMonth(), label: label.charAt(0).toUpperCase() + label.slice(1) };
    },
    /** Meeting clock: 03:12 or 1:02:03 */
    clock(sec) {
      if (sec === null || sec === undefined || isNaN(sec)) return "";
      sec = Math.max(0, Math.floor(sec));
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
      return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    },
    /** Short timer: 0:07, 12:40 */
    timer(sec) {
      sec = Math.max(0, Math.floor(sec || 0));
      const m = Math.floor(sec / 60), s = sec % 60;
      return m >= 60 ? this.clock(sec) : `${m}:${pad(s)}`;
    },
    duration(sec) {
      if (!(sec > 0)) return "";
      const total = Math.round(sec / 60);
      if (total < 1) return this.t("dur_lt1");
      const h = Math.floor(total / 60), m = total % 60;
      return h ? this.t("dur_hm", { h, m }) : this.t("dur_m", { m });
    },
    seconds(sec) { return this.t("dur_s", { s: this.num(sec, { maximumFractionDigits: 1 }) }); },
  };
  window.RecapperI18n = I;
})();
