| Паттерн  | Описание | ADR | Пример теста |
| ------------- | ------------- | ------------- | ------------- |
| Anti-corruption Layer  | За интеграцию с внешними системами ответственны отдельные микросервисы-адаптеры, инкапсулирующие в себе знания о внешних системах| [ADR](https://github.com/Byndyusoft/aact/blob/main/ADRs/Anti-corruption%20Layer.md)  | [тест](https://github.com/Byndyusoft/aact/blob/workshop/test/acl.test.ts)  |
| Пассивные CRUD-сервисы  | Микросервисы, отвечающие за доступ к мастер-данным, не обладают дополнительной логикой и не имеют зависимостей помимо своей БД  | [ADR](https://github.com/Byndyusoft/aact/blob/main/ADRs/Database%20per%20CRUD-service.md)  | [тест](https://github.com/Byndyusoft/aact/blob/workshop/test/crud.test.ts)  |
| API-Gateway  | Внешние для периметра REST-вызовы не должны идти напрямую   | <TBD ссылка>  | [тест](https://github.com/Byndyusoft/aact/blob/721edde3767dc0e51d19c80c3b6adba9fbf7b007/test/architecture.test.ts#L127C16-L127C16)  |
| Оркестратор распределённых транзакций | Запись данных идёт только через оркестратор бизнес-процессов, чтение доступно напрямую | <TBD ссылка>  | <TBD ссылка>  |
| Database per service | К БД имеет доступ только один микросервис  | [ADR](https://github.com/Byndyusoft/aact/blob/main/ADRs/Database%20per%20CRUD-service.md)  | [тест](https://github.com/Byndyusoft/aact/blob/workshop/test/crud.test.ts)  |
| Stable Dependencies Principle | Зависимости направлены от менее стабильных микросервисов к более стабильным  | <TBD ссылка>  | <TBD ссылка>  | 
| Acyclic Dependencies Principle | Граф зависимостей не должен содержать циклов  | <TBD ссылка>  | [тест](https://github.com/Byndyusoft/aact/blob/workshop/test/acyclic.test.ts)  | 
| Common Reuse Principle | Зависимость от контекста микросервисов использует внешнеконтекстные API всех микросервисов контекста   | <TBD ссылка>  | <TBD ссылка>  | 
| ... |  |   |   |
| ⚠️ | **Добавляйте свои примеры, вместе подумаем, как их покрыть тестами** |   |   |
