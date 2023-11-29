using System.Text;

namespace Monolith.ArchitectureTests.Modules
{
    /// <summary>
    ///     Описание модуля
    /// </summary>
    public class Module
    {
        private readonly string _contract = default!;
        private readonly string[] _implementation = Array.Empty<string>();
        private readonly (string, string)[] _internalReferences = Array.Empty<(string, string)>();

        /// <summary>
        ///     Название модуля
        /// </summary>
        public string Name { get; init; } = default!;

        /// <summary>
        ///     Список модулей от которых зависит этот модуль
        /// </summary>
        public List<string> ReferencedModules { get; init; } = new();

        /// <summary>
        ///     Алисы сборок в формате {алиас, сборка}.
        ///     Если алиасы не пустые, то для заполнения контракта, реализации и внутренних ссылок должны использовать алиасы
        /// </summary>
        public Dictionary<string, string> UseAssemblyAliases { get; init; } = new();

        /// <summary>
        ///     Название контрактной сборки
        /// </summary>
        public string Contract
        {
            get => _contract;
            init => _contract = UseAssemblyAliases.Any()
                                    ? UseAssemblyAliases[value]
                                    : value;
        }

        /// <summary>
        ///     Название сборок реализации модуля
        /// </summary>
        public string[] Implementation
        {
            get => _implementation;
            init => _implementation = UseAssemblyAliases.Any()
                                          ? value.Select(x => UseAssemblyAliases[x]).ToArray()
                                          : value;
        }

        /// <summary>
        ///     Связи между сборками внутри модуля в формате (сборка, подключаемая сборка)
        /// </summary>
        public (string, string)[] InternalReferences
        {
            get => _internalReferences;
            init => _internalReferences = UseAssemblyAliases.Any()
                                              ? value.Select(x => (UseAssemblyAliases[x.Item1], UseAssemblyAliases[x.Item2])).ToArray()
                                              : value;
        }

        /// <summary>
        ///     Получить все сборки модуля
        /// </summary>
        public IEnumerable<string> AllAssemblies => Implementation.Append(Contract);

        public override string ToString()
        {
            return Name;
        }
    }
}
