# HA/DRS: состав реализации для исследования

Дата фиксации: 2026-10-01.

## Краткий вывод

Пользователь уточнил границу исследования: **предоставленные архивы + все релевантные доработки `mimaric`**.
Это выбранный функциональный состав, а не подтверждение включённых флагов или готовой совместимой сборки.
В составе есть три разных механизма координации: host lock через Tooz, durable evacuation admission и Watcher automation hold.
Новая ветка admission заменяет прежнюю глобальную Tooz-блокировку evacuation при включённом guard.
HTML-анимация использует композиционный исследовательский профиль с предполагаемыми включёнными
PowerOps, Watcher hold guard и receiving-compute evacuation guard. Семь отдельных трасс иллюстрируют
аварийный и плановый пути; прежняя global Tooz evacuation lock в них не используется.

Исследование выполнено по исходникам, шаблонам, manifest и изолированным проверкам применимости патчей.
Не выполнялись сборка общего дерева, установка пакетов, развёртывание, обращения к кластеру и power-операции.

## 1. Зафиксированные исходники

SHA256 рассчитаны повторно по архивам рабочей папки. Обозначения K/M/F/W далее относятся к путям **внутри этих архивов**.

| ID | Архив | SHA256 |
|---|---|---|
| K | `kolla-ansible-pvs.zip` | `d951a3f31131efc70257883ce33620818db851ff40afbf21b63e3fd0616daec4` |
| M | `masakari-pvs_1.0.1.zip` | `45b55081e8fdd4a328ab726fe270e5f4cb574c92301da5dca9b6cb99b103ff7b` |
| F | `mistral-pvs_1.0.1.zip` | `04de5a3d383ba3f7c9d5597fa26fd5846c4789311c759a43c16cfcc24c19f004` |
| W | `watcher-pvs_1.0.0_21.09.zip` | `67722deaa94b4e606620519c34a3db84f3253c492e7238f78bf0045a65c2ac0b` |

Комплект P: [ветка `feature/masakari-per-target-evacuation`, commit `71b0123f390bfeaab4dc4ca2dffaa6fab32a6cdf`][P].
Именно этот снимок содержит исследованные hotfixes, библиотеки guard и историческую серию `horizon/patches`.
Отдельно проверенный `main`: [commit `2fc58f5c70632b344019603e69dc40d5f45cec43`][MAIN] — merge stand-test runner.
`main` на этом снимке нельзя подставлять вместо P: его README описывает запуск тестов на уже подготовленном baseline.
История тестов runner не доказывает работу исследуемой композиции на данном кластере.

### Расхождение с baseline 0809

[Manifest `baselines/0809.json`][B0809] требует другие архивы:

| Компонент | Имя архива 0809 | SHA256 0809 |
|---|---|---|
| Kolla | `kolla-ansible-enroll-ironic-patch-3_0809.zip` | `b5958f14a09b1bdad4edc9c6b3dd092f4376b55dee9d5814fd2ad78fdffb1be9` |
| Mistral | `mistral-integration-powerops-mistral-2025.1 _0809.zip` | `3df7cd4afa9052251107335b0ec5771c2704ccf03894c7e6c1f34880a43daf0c` |
| Masakari | `masakari-integration-powerops-masakari-2025.1_0809.zip` | `0bbda50f9553b65a5757d7cc43ed47b4d2a8cf99641c4b9ce88a01d09f1bcde9` |

Все три SHA отличаются от K/M/F. Manifest отдельно помечает совместимость `horizon` с 0809 как `not_verified`.
Для per-target kit заявлена цепочка 0809 → post-fence Nova-down → Watcher hold → per-target evacuation [E-MANIFEST].
Архивов Nova, masakari-monitors, Kolla image builder и mistral-lib в предоставленном наборе нет.
«Все доработки» здесь означает учесть актуальные функции и зависимости; это не инструкция накладывать каждую историческую `.patch` подряд.
Другие feature-ветки автоматически не включены. Horizon — отдельная разработка; `planned-return-v2` и planned-return kit выведены из текущего набора [P-README].
Локальный disk-monitor остаётся предложением ADR, а не реализованным источником событий [DISK-ADR].

## 2. Архив, состав с доработками и фактическое включение

| Область | Что есть в архивах | Что добавляет выбранный состав P | Включено на кластере? |
|---|---|---|---|
| Детектор | K: Consul driver, `all_down`, кандидатные manage/tenant/storage | Проверить совместимость фактического masakari-monitors | Не установлено |
| Host recovery | M: `PowerOpsCoordinator`, Tooz, etcd, host lock на весь recovery | Host lock сохраняется и при новом admission | Не установлено; K default PowerOps=no |
| Fencing | M: Ironic OFF и последующее ожидание Nova down | Prerequisite уже частично отражён в M, точное дерево отличается | Не установлено |
| Evacuation | M: последовательная global Tooz lock | Durable intent + VM/target/global-slot claims; проверка на receiving compute | Guard default=no |
| Watcher | W без исследованного automation guard | Masakari API/engine ставят hold; Watcher проверяет admission | Guard default=no |
| Mistral | K имеет workbook/config; F не содержит PowerOps actions | Серия `horizon/patches/mistral` содержит actions, координацию и RBAC | Образ и регистрация actions не проверены |
| Плановый возврат | K workbook содержит паузу inspection | Actions до/после паузы берут host lock по отдельности | Не установлено |
| Проверка стенда | В архивной модели нет доказательства runtime | `main` содержит отдельный stand-test runner | Его живой прогон здесь не выполнялся |

Основания K: `ansible/group_vars/all.yml:1045–1047,1110–1133,1137,1166,1186–1190,1272`;
`ansible/roles/masakari/templates/masakari.conf.j2:88–119`;
`ansible/roles/mistral/templates/mistral.conf.j2:108–127`.
Основания M: `masakari/engine/drivers/taskflow/driver.py:181–205`, `host_failure.py:405–427`;
для доработок — [E-DISPATCH], [E-GUARD], [W-MASAKARI], [M-COORD].

В F поиск `powerops|power_ops|openstack_power_actions` не дал совпадений; `setup.cfg:60–73` содержит std actions.
При этом K `ansible/roles/mistral/tasks/powerops.yml:2–23` ожидает `mistral.cmd.powerops_check` в контейнерах.
Это разрыв между исходными наборами, который необходимо закрыть выбором и проверкой Mistral source/image.

## 3. Три механизма координации

### 3.1. Host lock: PowerOps → Tooz → etcd

Логическое имя `powerops/host/<canonical Nova hostname>` разделяют recovery Masakari и плановые Mistral actions.
У Masakari lock охватывает весь host recovery; освобождение выполняется также при выходе через исключение.
Heartbeat Tooz и проверка UUID владения — разные проверки. `assert_healthy()` проверяет обе.
UUID lock нельзя отождествлять с notification UUID или Mistral action execution ID.
Успешная проверка владения не отменяет внешний API-запрос, уже ушедший до последующей потери lock.
Источник M: `masakari/powerops/coordination.py:35–38,61–91,114–197`; `driver.py:181–205`; [M-COORD].

### 3.2. Новый evacuation guard: прямые durable records в etcd

При `powerops_evacuation_guard.enabled=true` Masakari вызывает `evacuation.dispatch(...)`.
Старый цикл под `powerops/evacuation/global` находится в следующем `elif`, а не вокруг нового guard [E-DISPATCH].
Host lock при этом сохраняется. Новый guard требует включённого PowerOps и source coordinator.

Последовательность нового пути:

1. Masakari сохраняет intent `SUBMITTING`, request ID и VM claim до отправки `POST evacuate`.
2. Nova выбирает назначение; guard в принимающем nova-compute регистрирует `WAITING` до локального rebuild.
3. Etcd CAS атомарно проверяет VM claim, свободный target по ComputeNode UUID и свободный global slot.
4. После admission `RUNNING` receiving compute выполняет rebuild; успешный результат проходит completion proof.
5. `COOLDOWN` удерживает claims; после полной паузы переход в `DONE` атомарно освобождает VM/target/slot.
6. Masakari подтверждает результат по связанному operation и proof; одного статуса VM `ACTIVE` недостаточно.

Это библиотека в процессах Masakari/Nova с прямым etcd v3 API, **без Tooz и без lease/TTL claims** [E-ETCD], [E-GUARD].
`max_parallel=3` — общий admission limit контура; `submission_workers=3` — лимит одного процесса Masakari.
Успешная VM может быть ACTIVE во время `COOLDOWN`, когда recovery ещё не подтверждён.
`UNKNOWN` удерживает claims; истечение таймера само по себе не даёт разрешения повторить rebuild.
Operator resolve требует точной revision и внешнего подтверждения terminal/quiesced; CLI эти факты не устанавливает.
Источники: [E-NOVA], [E-GUARD], [E-CONFIG], [E-README].

### 3.3. Watcher automation hold: отдельный persistent gate

При включённом guard для `COMPUTE_HOST`, `event=STOPPED`, `host_status=NORMAL`
Masakari API ставит hold до `notification.create()` и RPC; engine повторяет его идемпотентно до recovery [W-MASAKARI].
Новый incident создаёт новый UUID epoch; повтор того же incident его не меняет.
Namespace `/powerops/watcher-automation/v1` хранит state/incidents без lease/TTL [W-GATE].
Guard ограничивает новые CONTINUOUS audits и допуски действий/rollback их планов.
`ONESHOT`/`EVENT` маркируются manual и обходят этот guard; уже допущенное действие может позже обратиться к Nova.
Recovery не снимает hold автоматически. Оператор выполняет CAS-resume, меняя epoch; старые планы не возобновляются.
Этот gate не распространяется на плановые Mistral actions. Его нельзя изображать единой блокировкой всех HA/DRS действий.
Источники: [W-WATCHER], [W-GATE], [W-DOC].

## 4. Границы Mistral

Серия P содержит PowerOps actions с Tooz/etcd host lock и проверкой здоровья координации [M-COORD].
Lock принадлежит одному composite action, а не всему workflow [M-BOUNDARY].
`power_on_and_return`: action power-on → operator pause **без удержания action lock** → action return-to-service с новым acquire.
Read-only `host_power_status` lock не берёт. Cleanup failure после completed operation не означает повтор физической операции.
Функциональная семантика патчей проверена по исходникам; их совместимость с F в составе общего дерева не установлена.
Источники: [M-RETURN], [M-WORKBOOK]; K `ansible/roles/mistral/files/power_ops.yaml:60–88`.

## 5. Параметры иллюстрации и неподтверждённая конфигурация

В K `enable_powerops=no`; `enable_masakari`, `enable_mistral`, `enable_ironic`, `enable_etcd` зависят от него.
K `etc/kolla/globals.yml:918,922–925` явно включает Consul, выбирает Consul driver/`all_down` и Redis.
Обычный Masakari API backend выбирает Redis первым; PowerOps-ветка явно переключает API/engine на etcd.
K default Watcher=yes сам по себе не включает Watcher guard. Оба новых guard по умолчанию выключены [E-CONFIG], [W-CONFIG].

Сетей не обязательно три: K `ansible/roles/consul/tasks/main.yml:11–43` вычисляет enabled per-host по именам интерфейсов.
Матрица включает только enabled+masakari_monitor; `all_down` относится к фактическому числу включённых сетей.
Источник: K `kolla_ansible/masakari_consul.py:67–109,190–213`.
Template использует `masakari_hostmonitor_* = 60 секунд / 1 sample`, а не соседние `masakari_consul_* = 30 / 3`.
Источник: K `ansible/group_vars/all.yml:640–641,1111–1112`; `masakari-monitors.conf.j2:45–46`.

**Композиционный исследовательский профиль HTML:** PowerOps и оба guard предполагаются включёнными,
policy=`all_down`, recovery method=`auto`, эффективный набор сетей — `manage/tenant/storage`.
В `normal` свежий вектор `down/down/down` разрешает recovery; в `hold` вектор `down/up/up` его запрещает.
Для `COOLDOWN` в успешной иллюстрации задано 5 секунд; claims удерживаются весь интервал.
Это условия иллюстрации, **не сведения о действующих настройках**, измеренные длительности или команда
изменения кластера. Независимость отказов трёх сетей данным выбором не утверждается.
Профили P0/P1 исходной модели SC-01 v0.1 остаются без изменения.

## 6. Изолированная проверка применимости патчей

Выполнены только `git apply --check` непосредственно в неизменённых распакованных K/M/W.
PASS означает применимость текста одного патча; FAIL может означать другую базу, уже внесённые части или отсутствующую зависимость.

| Проверенный патч P | Дерево | Результат |
|---|---|---|
| post-fence Nova-down `0001` | M | FAIL: nova.py, conf/powerops.py, taskflow/powerops.py, тесты; test_nova_down.py уже существует |
| Watcher/Masakari `0000` prerequisite | M | FAIL: те же ошибки |
| Watcher/Masakari `0001` hold | M | PASS |
| Watcher/Watcher `0001` | W | PASS |
| Watcher/Kolla `0001` | K | FAIL: all.yml, globals.yml, test_powerops_configuration_contract.py |
| Per-target/Masakari `0001` | M | FAIL: conf/__init__.py, host_failure.py, requirements.txt |
| Per-target/Kolla `0001` | K | FAIL: all.yml, Masakari precheck/template, два configuration/template tests |
| Per-target/Nova `0001` | — | Не проверен: исходников Nova нет |

Для обеих копий post-fence выполнен также `git apply --reverse --check`: FAIL.
Reverse ошибки: отсутствует `releasenotes/notes/powerops-post-fence-nova-down-57aa90a6c4c65c21.yaml`,
не подходит hunk `masakari/engine/drivers/taskflow/powerops.py:29`.
Функция ожидания Nova down есть в M, но точный результат prerequisite не совпадает с архивом.
Полная цепочка с применением зависимостей не собиралась. Вторые/третьи patches Kolla отдельно не проверялись.
Ни один PASS здесь не является доказательством совместимости композиции или её поведения во время отказа.

## 7. Что отражает анимация композиционного профиля

`HA_DRS_ANIMATION.html` и `visualizations/ha-recovery-animation.html` показывают
исследовательскую композицию архивов и P, а не собранное общее дерево исходников или deployment.
Отдельно представлены Masakari API/engine, Nova scheduling/receiving compute, Mistral и Watcher.
PowerOps/Tooz размещены внутри процессов Masakari/Mistral, guards — внутри Masakari/Nova;
etcd является внешним backend. Три индикатора различают host lock, durable claims и Watcher hold.
Запросы и ответы имеют направление, локальные события не изображаются сетевым сообщением самому себе.

| Ключ | Что иллюстрируется |
|---|---|
| `normal` | API hold до notification, идемпотентный engine hold, host lock, disable → fencing/Off evidence → Nova down, intent/VM claim до POST, выбранный Nova target, receiving `WAITING` → CAS admission → `RUNNING`/rebuild → proof → `COOLDOWN` → `DONE`, подтверждение Masakari и release host lock |
| `lost` | Fencing evidence timeout запрещает evacuation; Masakari завершает попытку ошибкой и освобождает host lock |
| `hold` | При `all_down` свежий `down/up/up` не допускает recovery |
| `planned` | Mistral `planned_power_off` с `require_empty` на пустом хосте держит lock одного action, проверяет условия, выключает хост и освобождает lock |
| `contention` | Mistral ждёт host lock, которым владеет Masakari, получает timeout/`ERROR` и не отправляет power-команду |
| `return` | Отдельный пустой источник в maintenance и пустой manifest; операторские предусловия предполагаются выполненными. Power-on action освобождает lock перед `PAUSED`; явный модельный resume ведёт к новому acquire и повторным проверкам return action |
| `unknown` | Потеря ответа сначала даёт `intent.observation=UNKNOWN` при operation `RUNNING`; последующая ошибка completion proof даёт `operation.state=UNKNOWN` с удержанием claims и без автоматического retry |

В успешном `normal` claims освобождаются атомарно при `COOLDOWN → DONE`, после полного интервала
5 секунд, затем Masakari подтверждает результат и освобождает host lock. Watcher остаётся `BLOCKED`;
успех HA не снимает persistent hold. `return` не является автоматическим продолжением HA:
в `PAUSED` анимация прекращает автоматический переход и ждёт отдельной кнопки подтверждения оператора.
На паузе action lock свободен; следующий action получает его заново.

Потеря ответа на POST у Masakari отмечает `intent.observation=UNKNOWN`; receiving operation при этом
может продолжать `RUNNING → COOLDOWN → DONE`. Неизвестность наблюдателя не равна
`operation.state=UNKNOWN`. Сценарий `unknown` отдельно вводит ошибку completion proof;
после неё claims сохраняются. Ни timeout, ни release host lock не разрешают автоматический retry.
При ошибке POST Masakari не начинает polling успешного результата: отмечает failure и выполняет cleanup.
В `unknown` принимающий compute продолжает работу независимо после освобождения host lock.
В успешной трассе подтверждение Masakari включает Nova readback до проверки operation/proof
и заключительную проверку Nova; одного ответа etcd недостаточно.

Новые ID событий HTML независимы от переходов исходного SC-01 v0.1. Это иллюстративные трассы,
не результаты model checker. `node --test tests/animation-traces.test.cjs` проверяет временные
свойства их данных, а не production-код, совместимость патчей или поведение стенда.
Для выводов о реализации ещё требуется интеграционная копия с проверенным порядком патчей,
а для формальных выводов — исполняемая модель и трассы её проверки.

## Источники P: неизменяемые ссылки

[P]: https://github.com/lebtmalorny-rgb/mimaric/tree/71b0123f390bfeaab4dc4ca2dffaa6fab32a6cdf
[P-README]: https://github.com/lebtmalorny-rgb/mimaric/blob/71b0123f390bfeaab4dc4ca2dffaa6fab32a6cdf/README.md#L3-L7
[DISK-ADR]: https://github.com/lebtmalorny-rgb/mimaric/blob/71b0123f390bfeaab4dc4ca2dffaa6fab32a6cdf/docs/adr/0001-local-disk-monitor.md#L1-L15
[MAIN]: https://github.com/lebtmalorny-rgb/mimaric/blob/2fc58f5c70632b344019603e69dc40d5f45cec43/README.md
[B0809]: https://github.com/lebtmalorny-rgb/mimaric/blob/71b0123f390bfeaab4dc4ca2dffaa6fab32a6cdf/baselines/0809.json
[E-MANIFEST]: https://github.com/lebtmalorny-rgb/mimaric/blob/71b0123f390bfeaab4dc4ca2dffaa6fab32a6cdf/hotfixes/masakari-per-target-evacuation/manifest.json
[E-DISPATCH]: https://github.com/lebtmalorny-rgb/mimaric/blob/71b0123f390bfeaab4dc4ca2dffaa6fab32a6cdf/hotfixes/masakari-per-target-evacuation/masakari/0001-Add-durable-evacuation-intents-and-process-wide-Masa.patch#L239-L438
[E-NOVA]: https://github.com/lebtmalorny-rgb/mimaric/blob/71b0123f390bfeaab4dc4ca2dffaa6fab32a6cdf/hotfixes/masakari-per-target-evacuation/nova/0001-Guard-receiving-compute-evacuation-with-durable-per-.patch#L162-L287
[E-ETCD]: https://github.com/lebtmalorny-rgb/mimaric/blob/71b0123f390bfeaab4dc4ca2dffaa6fab32a6cdf/packages/powerops-evacuation-guard/powerops_evacuation_guard/etcd.py#L113-L190
[E-GUARD]: https://github.com/lebtmalorny-rgb/mimaric/blob/71b0123f390bfeaab4dc4ca2dffaa6fab32a6cdf/packages/powerops-evacuation-guard/powerops_evacuation_guard/guard.py#L218-L453
[E-CONFIG]: https://github.com/lebtmalorny-rgb/mimaric/blob/71b0123f390bfeaab4dc4ca2dffaa6fab32a6cdf/packages/powerops-evacuation-guard/powerops_evacuation_guard/config.py#L7-L20
[E-README]: https://github.com/lebtmalorny-rgb/mimaric/blob/71b0123f390bfeaab4dc4ca2dffaa6fab32a6cdf/packages/powerops-evacuation-guard/README.md#L98-L139
[W-MASAKARI]: https://github.com/lebtmalorny-rgb/mimaric/blob/71b0123f390bfeaab4dc4ca2dffaa6fab32a6cdf/hotfixes/watcher-automation-hold/masakari/0001-feat-hold-Watcher-automation-on-host-failure.patch#L76-L243
[W-WATCHER]: https://github.com/lebtmalorny-rgb/mimaric/blob/71b0123f390bfeaab4dc4ca2dffaa6fab32a6cdf/hotfixes/watcher-automation-hold/watcher/0001-Guard-scheduled-Watcher-audits-and-actions-with-pers.patch#L43-L200
[W-GATE]: https://github.com/lebtmalorny-rgb/mimaric/blob/71b0123f390bfeaab4dc4ca2dffaa6fab32a6cdf/packages/powerops-watcher-guard/powerops_watcher_guard/gate.py#L240-L322
[W-CONFIG]: https://github.com/lebtmalorny-rgb/mimaric/blob/71b0123f390bfeaab4dc4ca2dffaa6fab32a6cdf/packages/powerops-watcher-guard/powerops_watcher_guard/config.py#L9-L15
[W-DOC]: https://github.com/lebtmalorny-rgb/mimaric/blob/71b0123f390bfeaab4dc4ca2dffaa6fab32a6cdf/docs/WATCHER-AUTOMATION-HOLD.md#L140-L153
[M-COORD]: https://github.com/lebtmalorny-rgb/mimaric/blob/71b0123f390bfeaab4dc4ca2dffaa6fab32a6cdf/horizon/patches/mistral/0001-feat-add-PowerOps-action-coordination.patch#L46-L288
[M-BOUNDARY]: https://github.com/lebtmalorny-rgb/mimaric/blob/71b0123f390bfeaab4dc4ca2dffaa6fab32a6cdf/horizon/patches/mistral/0006-fix-harden-planned-action-boundaries.patch#L33-L135
[M-RETURN]: https://github.com/lebtmalorny-rgb/mimaric/blob/71b0123f390bfeaab4dc4ca2dffaa6fab32a6cdf/horizon/patches/mistral/0007-feat-add-guarded-host-return-actions.patch#L45-L177
[M-WORKBOOK]: https://github.com/lebtmalorny-rgb/mimaric/blob/71b0123f390bfeaab4dc4ca2dffaa6fab32a6cdf/horizon/patches/mistral/0008-feat-register-the-PowerOps-workbook-API.patch#L83-L111
