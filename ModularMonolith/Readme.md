# Тестирование архитектуры модульного монолита на C#

Архитектура модульного монолита описывается правилами организации и взаимодействия модулей.

Имея описание целевой архитектуры можно проверить, соответствует ли реальная архитектура целевой.

## Модули

Модуль - это несколько сборок объединённых одним названием. Обычно помещаются в отдельную папку.

Для модулей действуют правила, каждое из которых можно проверить:
* Каждый модуль имеет контрактную сборку и, возможно, сборки с реализацией.
* Одни модули могут использовать другие модули, но только через контрактную сборку. Доступ к другим сборкам модуля из других модулей запрещён.
* Зависимости между модулями должны образовывать ориентированный граф без циклов. 
* Сборки модулей должны подключить только модули, которые есть в целевой архитектуре

## Реализация тестов

Текущее решение демонстрирует как можно декларативно описать связи между модулями в виде кода и тестом проверить, что реальные связи между сборками соответствуют этому описанию.

Тесты не имеют зависимостей и могут запускаться на CI/CD как обычные юнит тесты.

.net нюанс - если подключить к проекту другой проект, но не использовать из него ни один тип, то в скомпилированной сборке не будет ссылки на сборку из другого проекта. 

Пример описания

```C#
new[]
{
new Module
    {
        Name = "Common",
        Contract = "Common.Contracts",
        Implementation = ["Common.Domain"],
        InternalReferences = [
                                ("Common.Domain", "Common.Contracts")
                            ]
    },
new Module
    {
        Name = "Emails",
        ReferencedModules = { "Common" },
        Contract = "Emails.Contracts",
        Implementation = ["Emails.Domain"],
        InternalReferences = [
                                ("Emails.Domain", "Emails.Contracts")
                            ]
    },
new Module
    {
        Name = "Audit",
        ReferencedModules = { "Common" },
        Contract = "Audit.Contracts",
        Implementation = ["Audit.Domain"],
        InternalReferences = [
                                ("Audit.Domain", "Audit.Contracts")
                            ]
    },
new Module
    {
        Name = "Shedule",
        ReferencedModules = { "Common", "Emails", "Audit" },
        Contract = "Shedule.Contract",
        Implementation = ["Shedule.Domain", "Shedule.DataAccess"],
        InternalReferences = [
                                ("Shedule.Domain", "Shedule.Contract"),
                                ("Shedule.DataAccess", "Shedule.Domain")
                            ]
    },
    //И т.д.

};
```

Из описания можно построить диаграммы зависимостей модулей.

Модули:
<img src="https://raw.githubusercontent.com/Byndyusoft/aact/main/ModularMonolith/Architecture.svg">

Модули и сборки:
<img src="https://raw.githubusercontent.com/Byndyusoft/aact/main/ModularMonolith/DetailedArchitecture.svg">