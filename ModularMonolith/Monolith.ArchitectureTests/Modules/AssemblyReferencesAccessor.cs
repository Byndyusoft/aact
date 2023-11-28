namespace Monolith.ArchitectureTests.Modules
{
    using System.Reflection;

    /// <summary>
    ///     Предоставляется доступ к ссылкам сборок
    /// </summary>
    public class AssemblyReferencesAccessor
    {
        private readonly Dictionary<string, string[]> _referencesByName = [];

        /// <summary>
        ///     Получить все сборки связанных с указанной сборкой
        /// </summary>
        public string[] GetReferences(string assemblyName)
        {
            if (_referencesByName.TryGetValue(assemblyName, out var references))
                return references;

            var assembly = Assembly.Load(assemblyName);
            references = assembly.GetReferencedAssemblies().Select(x => x.Name!).ToArray();
            _referencesByName[assembly.GetName().Name!] = references;

            return references;
        }
    }
}
