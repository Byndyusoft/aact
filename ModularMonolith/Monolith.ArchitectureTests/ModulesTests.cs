using Monolith.ArchitectureTests.Modules;
using System.Text;
using Xunit.Abstractions;

namespace Monolith.ArchitectureTests
{
    public class ModulesTests
    {
        private readonly ITestOutputHelper _output;

        public ModulesTests(ITestOutputHelper output)
        {
            _output = output;
        }

        [Fact]
        public void TestModuleArchitecture()
        {
            var assemblies = new AssemblyReferencesAccessor();

            var modules = GetModules();

            ModulesShouldNotContainCyclicDependencies(modules);
            ModuleContainReferenceOnlyToReferencedModules(modules, assemblies);
            OnlyContractShouldBeReferenced(modules, assemblies);
            ContractShouldNotReferenceModules(modules, assemblies);
        }

        private static void ModulesShouldNotContainCyclicDependencies(Module[] modules)
        {
            var modulesByNames = modules.ToDictionary(x => x.Name);
            foreach (var module in modules)
                IsNotContainCyclic(module, new Stack<string>(), modulesByNames);
        }

        private static void IsNotContainCyclic(Module module, Stack<string> checkedModules, Dictionary<string, Module> modulesByName)
        {
            checkedModules.Push(module.Name);

            foreach (var referencedModule in module.ReferencedModules)
            {
                if (checkedModules.Contains(referencedModule))
                    throw new Exception("Обнаружена циклическая зависимость модулей: " + string.Join(" -> ", checkedModules.Reverse().Append(referencedModule)));

                IsNotContainCyclic(modulesByName[referencedModule], checkedModules, modulesByName);
            }

            checkedModules.Pop();
        }

        [Fact]
        public void ExportDetailedMermaidDiagram()
        {
            var sb = new StringBuilder();
            sb.AppendLine("```mermaid");
            sb.AppendLine("flowchart BT");

            foreach (var module in GetModules())
            {
                sb.AppendLine();
                sb.AppendLine("subgraph " + module.Name);
                foreach (var assembly in module.AllAssemblies)
                {
                    sb.AppendLine("\t" + assembly);
                }

                foreach (var (assembly, dependOn) in module.InternalReferences)
                {
                    sb.AppendLine("\t" + dependOn + " --> " + assembly);
                }

                sb.AppendLine("end");

                foreach (var referencedModule in module.ReferencedModules)
                {
                    sb.AppendLine(referencedModule + " --> " + module.Name);
                }
            }

            sb.AppendLine("```");

            _output.WriteLine(sb.ToString());
        }

        [Fact]
        public void ExportMermaidDiagram()
        {
            var sb = new StringBuilder();
            sb.AppendLine("```mermaid");
            sb.AppendLine("flowchart BT");

            foreach (var module in GetModules())
            {
                sb.AppendLine();
                sb.AppendLine(module.Name);

                foreach (var referencedModule in module.ReferencedModules)
                {
                    sb.AppendLine(referencedModule + " --> " + module.Name);
                }
            }

            sb.AppendLine("```");

            _output.WriteLine(sb.ToString());
        }

        private static Module[] GetModules()
        {
            var modules = new[]
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
                              new Module
                                  {
                                      Name = "ProjectQuality",
                                      ReferencedModules = { "Common" },
                                      UseAssemblyAliases =
                                          {
                                              {"Contract", "Byndyusoft.ProjectQuality.Contracts"},
                                              {"Domain", "Byndyusoft.ProjectQuality.Domain"},
                                              {"DataAccess", "Byndyusoft.ProjectQuality.DataAccess"},
                                          },
                                      Contract = "Contract",
                                      Implementation = ["Domain", "DataAccess"],
                                      InternalReferences = [
                                                               ("Domain", "Contract"),
                                                               ("DataAccess", "Domain")
                                                           ]
                                  },
                              new Module
                                  {
                                      Name = "Customers",
                                      ReferencedModules = { "Audit", "Common" },
                                      UseAssemblyAliases =
                                          {
                                              {"Contract", "Byndyusoft.Customers.Contracts"},
                                              {"Domain", "Byndyusoft.Customers.Domain"},
                                              {"DataAccess", "Byndyusoft.Customers.DataAccess" },
                                              {"Processing", "Byndyusoft.Customers.Processing" },
                                          },
                                      Contract = "Contract",
                                      Implementation = ["Domain", "DataAccess", "Processing"],
                                      InternalReferences = [
                                                               ("Domain", "Contract"),
                                                               ("Processing", "Domain"),
                                                               ("DataAccess", "Domain")
                                                           ]
                                  },
                              new Module
                                  {
                                      Name = "BFF",
                                      ReferencedModules = { "Shedule", "ProjectQuality", "Customers" },
                                      Contract = "Monolith.BFF",
                                      Implementation = [],
                                      InternalReferences = []
                                  }
                          };
            return modules;
        }

        /// <summary>
        ///     Ссылка на другой модуль должна вести только на его контракт
        /// </summary>
        private static void OnlyContractShouldBeReferenced(Module[] modules, AssemblyReferencesAccessor assembliesReferences)
        {
            foreach (var module in modules)
            {
                foreach (var referencedModuleName in module.ReferencedModules)
                {
                    var referencedModule = modules.Single(x => x.Name == referencedModuleName);
                    foreach (var assemblyName in module.AllAssemblies)
                    {
                        var referencedAssemblies = assembliesReferences.GetReferences(assemblyName);

                        foreach (var denyAssembly in referencedModule.Implementation)
                        {
                            referencedAssemblies.Should().NotContain(denyAssembly,
                                                                     $"Модуль {module.Name} может подключить только контракт модуля {referencedModule.Name} ({referencedModule.Contract}) ");
                        }
                    }
                }
            }
        }

        /// <summary>
        ///     У сборках модулей не должно быть ссылок на другие модули, кроме тех, что указаны в связях.
        /// </summary>
        private static void ModuleContainReferenceOnlyToReferencedModules(Module[] modules, AssemblyReferencesAccessor assembliesReferences)
        {
            foreach (var module in modules)
            {
                var denyModules = modules.Where(x => x != module)
                                         .Where(x => module.ReferencedModules.Contains(x.Name) == false);

                foreach (var denyModule in denyModules)
                {
                    foreach (var assemblyName in module.AllAssemblies)
                    {
                        var referencedAssemblies = assembliesReferences.GetReferences(assemblyName);

                        foreach (var denyAssembly in denyModule.AllAssemblies)
                        {
                            referencedAssemblies.Should().NotContain(denyAssembly, $"Сборки модуля {module.Name} не должны подключать сборки модуля {denyModule.Name}");
                        }
                    }
                }
            }
        }

        /// <summary>
        ///     Контракты не ссылаются на другие модули вообще
        /// </summary>
        private static void ContractShouldNotReferenceModules(Module[] modules, AssemblyReferencesAccessor assembliesReferences)
        {
            foreach (var module in modules)
            {
                var othersModules = modules.Where(x => x != module);

                foreach (var otherModule in othersModules)
                {
                    var referencedAssemblies = assembliesReferences.GetReferences(module.Contract);

                    foreach (var denyAssembly in otherModule.AllAssemblies)
                    {
                        referencedAssemblies.Should().NotContain(denyAssembly,
                                                                 $"Контракт модуля {module.Name} ({module.Contract}) не должен подключать другие модули {otherModule.Name}");
                    }
                }
            }
        }
    }
}