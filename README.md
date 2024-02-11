# Architecture As Code Tests
[![test workflow](https://github.com/razonrus/ArchAsCode_Tests/actions/workflows/test.yaml/badge.svg?branch=main)](https://github.com/razonrus/ArchAsCode_Tests/actions/workflows/test.yaml)

Код и примеры покрытия тестами микросервисной архитектуры, описанной в [plantuml](https://plantuml.com/ru/)

PullRequest'ы и Issues'ы приветствуются.<br/>
Обсудить можно, например, в [чате](https://t.me/rsa_chat) [канала](https://t.me/rsa_enc)

## Запись доклада 
[![video](http://img.youtube.com/vi/tZ-FQeObSjY/0.jpg)](https://www.youtube.com/watch?v=tZ-FQeObSjY "Раз архитектура — «as Code», почему бы её не покрыть тестами?! / Руслан Сафин (Бындюсофт)")

https://www.youtube.com/watch?v=tZ-FQeObSjY

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
