# Architecture As Code Tools
[![test workflow](https://github.com/razonrus/ArchAsCode_Tests/actions/workflows/test.yaml/badge.svg?branch=main)](https://github.com/razonrus/ArchAsCode_Tests/actions/workflows/test.yaml)

Инструменты для работы с архитектурой в формате "as Code": 
1. Код и примеры покрытия тестами микросервисной архитектуры, описанной в plantuml ([#](#%D0%BF%D0%BE%D0%BA%D1%80%D1%8B%D1%82%D0%B8%D0%B5-%D0%B0%D1%80%D1%85%D0%B8%D1%82%D0%B5%D0%BA%D1%82%D1%83%D1%80%D1%8B-%D1%82%D0%B5%D1%81%D1%82%D0%B0%D0%BC%D0%B8))
2. Автогенерация архитектуры ([#](#%D0%B0%D0%B2%D1%82%D0%BE%D0%B3%D0%B5%D0%BD%D0%B5%D1%80%D0%B0%D1%86%D0%B8%D1%8F-%D0%B0%D1%80%D1%85%D0%B8%D1%82%D0%B5%D0%BA%D1%82%D1%83%D1%80%D1%8B-1))
3. Тестирование архитектуры модульного монолита ([#](#%D1%82%D0%B5%D1%81%D1%82%D0%B8%D1%80%D0%BE%D0%B2%D0%B0%D0%BD%D0%B8%D0%B5-%D0%BC%D0%BE%D0%B4%D1%83%D0%BB%D1%8C%D0%BD%D0%BE%D0%B3%D0%BE-%D0%BC%D0%BE%D0%BD%D0%BE%D0%BB%D0%B8%D1%82%D0%B0))

PullRequest'ы и Issues'ы приветствуются.<br/>
<img src="https://github.com/Byndyusoft/aact/assets/1096954/a3c3b3b0-a09b-4da7-aca4-5538159b371c" width="15"/> Телеграм-канал: [Архитектура распределённых систем](https://t.me/rsa_enc)

## Публичные материалы 
### Раз архитектура — «as Code», почему бы её не покрыть тестами?!
<a href="https://www.youtube.com/watch?v=POIbWZh68Cg"><img src="https://github.com/Byndyusoft/aact/assets/1096954/e011958e-12c8-4fb9-97f4-a61779408e4f" width="400"/></a>
<a href="https://www.youtube.com/watch?v=tZ-FQeObSjY"><img src="https://github.com/Byndyusoft/aact/assets/1096954/daea29de-776b-49a0-b781-ad4eba9a2221" width="400"/></a>
https://www.youtube.com/watch?v=POIbWZh68Cg $~~~~~~~~~~$ https://www.youtube.com/watch?v=tZ-FQeObSjY

[Статья на Хабре](https://habr.com/ru/articles/800205/)

### Автогенерация архитектуры
<a href="https://www.youtube.com/watch?v=fb2UjqjHGUE"><img src="https://github.com/Byndyusoft/aact/assets/1096954/ecb54a6f-f6c1-4816-972b-c845069e9f4a" width="400"/></a><br/>
https://www.youtube.com/watch?v=fb2UjqjHGUE

# Покрытие архитектуры тестами 
## Что это, какую боль решает, и с чего начать?
Раз архитектура — «as Code», почему бы её не покрыть тестами?!

Тема идеи и данный открытый репозиторий вызвал неожиданную волну позитивных отзывов о попадании в яблочко болей и о применимости и полезности решения :) 

Подход помогает решить **проблемы неактуальности, декларативности и отсутствия контроля ИТ-архитектур и инфраструктуры** (ограничение и требование — архитектура и инфраструктура должны быть "as code").

Тесты проверяют 2 больших блока:
- актуальность архитектуры реальному работающему в продакшне решению
- соответствие "нарисованной" архитектуры выбранным принципам и паттернам проектирования

Подробнее о подходе, решаемых проблемах, схеме работы представленного в репозитории примера и проверяемых в тестах репозитория принципах — на [слайдах](https://docs.google.com/presentation/d/16_3h1BTIRyREXO_oSqnjEbRJAnN3Z4aX/edit?usp=sharing&ouid=106100367728328513490&rtpof=true&sd=true).

### Схема работы
<img src="https://github.com/Byndyusoft/aact/assets/1096954/9b0ad909-b789-4395-a580-9fb44397afa0" height="350">

### Визуализация примера автоматически проверяемого принципа (отсутствие бизнес-логики в CRUD-сервисах)
<img src="https://github.com/Byndyusoft/aact/assets/1096954/292b1bbd-0f18-40be-9560-65385a1d4df9" height="300">


## Пример архитектуры, которую покроем тестами
[![C4](./architecture/Demo%20Tests.svg)](./architecture/Demo%20Tests.svg)

## Пример тестов
1. [Finds diff in configs and uml containers](https://github.com/razonrus/aact/blob/721edde3767dc0e51d19c80c3b6adba9fbf7b007/test/architecture.test.ts#L43C10-L43C48) — проверяет актуальность списка микросервисов на архитектуре и в [конфигурации инфраструктуры](https://github.com/razonrus/aact/tree/main/kubernetes/microservices)
2. [Finds diff in configs and uml dependencies](https://github.com/razonrus/aact/blob/721edde3767dc0e51d19c80c3b6adba9fbf7b007/test/architecture.test.ts#L52C9-L52C9) — проверяет актуальность зависимостей (связей) микросервисов на архитектуре и в [конфигурации инфраструктуры](https://github.com/razonrus/aact/tree/main/kubernetes/microservices)
3. [Check that urls and topics from relations exists in config](https://github.com/razonrus/aact/blob/721edde3767dc0e51d19c80c3b6adba9fbf7b007/test/architecture.test.ts#L86C5-L86C5) — проверяет соответствие между параметрами связей микросервисов (REST-урлы, топики kafka) на архитектуре и в [конфигурации инфраструктуры](https://github.com/razonrus/aact/tree/main/kubernetes/microservices)
4. [Only acl can depence from external systems](https://github.com/razonrus/aact/blob/721edde3767dc0e51d19c80c3b6adba9fbf7b007/test/architecture.test.ts#L111C7-L111C49) — проверяет, что не нарушен выбранный принцип построения интеграций с внешними системами только через ACL (Anti Corruption Layer). Проверяет, что только acl-микросервисы имеют зависимости от внешних систем.
5. [Connect to external systems only by API Gateway or kafka](https://github.com/razonrus/aact/blob/721edde3767dc0e51d19c80c3b6adba9fbf7b007/test/architecture.test.ts#L127C16-L127C16) — проверяет, что все внешние интеграции идут через API Gateway или через kafka

# Автогенерация архитектуры 
## Генерация архитектуры из описанной «as Code» инфраструктуры
Добавил [код](https://github.com/Byndyusoft/aact/blob/39d8141a241f1139d5e58061f8674a22341b72de/test/architecture.test.ts#L214), который полностью с нуля генерирует архитектуру в plantuml по данным из IaC.

Сравнение ~~белковой~~ составленной вручную архитектуры и сгенерированной.
### Ручная:
[![C4](./architecture/Demo%20Tests.svg)](./architecture/Demo%20Tests.svg)
### Сгенерированная:
[![C4](./architecture/Demo%20Generated.svg)](./architecture/Demo%20Generated.svg)

# Тестирование модульного монолита

Тестами можно покрывать не только архитектуру микросервисов, но архитектуру монолитов, особенно, если они модульные.

*  [Тест архитектуры модульного монолита на C#](https://github.com/Byndyusoft/aact/tree/main/ModularMonolith)
