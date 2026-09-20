// assembly-to-aact — turn compiled .NET assemblies into an aact Model by
// reading AssemblyReference metadata straight from the PE files.
//
// This is the *compiled* dependency graph: what survived the build. A
// ProjectReference that nobody uses does not end up here, so this view answers
// "does the code actually depend on it?" — see csproj-to-aact.mjs for the
// declared view.
//
// Usage:
//   dotnet run --project tools/assembly-to-aact -- <assembly-dir> <output.aact.json>
//                                                  [--boundary <label>] [--tags <file>]
//
// Assemblies are matched by file name inside <assembly-dir>: references to the
// framework and to NuGet packages are ignored, only your own modules stay.

using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text.Json;

if (args.Length < 2)
{
    Console.Error.WriteLine(
        "Usage: assembly-to-aact <assembly-dir> <output.aact.json> [--boundary <label>] [--tags <file>]");
    return 2;
}

var assemblyDirectory = args[0];
var outputPath = Path.GetFullPath(args[1]);
var boundaryLabel = "Monolith";
var tagsByProject = new Dictionary<string, string[]>();

for (var i = 2; i < args.Length - 1; i++)
{
    if (args[i] == "--boundary") boundaryLabel = args[++i];
    else if (args[i] == "--tags")
        tagsByProject = JsonSerializer.Deserialize<Dictionary<string, string[]>>(
            File.ReadAllText(args[++i])) ?? tagsByProject;
}

// Stable element id: `Inventory.Contracts` → `inventory_contracts`.
// Must match csproj-to-aact.mjs, otherwise the two graphs cannot be compared.
static string IdOf(string assemblyName)
{
    var id = new string(assemblyName.ToLowerInvariant()
        .Select(c => char.IsAsciiLetterOrDigit(c) ? c : '_').ToArray());
    return id.Trim('_');
}

static string[] ReferencesOf(string assemblyPath)
{
    using var stream = File.OpenRead(assemblyPath);
    using var peReader = new PEReader(stream);
    var metadata = peReader.GetMetadataReader();
    return metadata.AssemblyReferences
        .Select(handle => metadata.GetString(metadata.GetAssemblyReference(handle).Name))
        .ToArray();
}

var ownAssemblies = Directory.GetFiles(assemblyDirectory, "*.dll")
    .ToDictionary(path => Path.GetFileNameWithoutExtension(path)!, path => path);

var elements = new Dictionary<string, object>();
var edgeCount = 0;
foreach (var (assemblyName, assemblyPath) in ownAssemblies.OrderBy(pair => pair.Key))
{
    var relations = ReferencesOf(assemblyPath)
        .Where(ownAssemblies.ContainsKey)
        .OrderBy(name => name)
        .Select(name => new
        {
            to = IdOf(name),
            description = "",
            tags = Array.Empty<string>(),
            technology = "AssemblyReference",
        })
        .ToArray();

    edgeCount += relations.Length;
    elements[IdOf(assemblyName)] = new
    {
        name = IdOf(assemblyName),
        label = assemblyName,
        kind = "Component",
        external = false,
        description = "",
        technology = "dotnet",
        tags = tagsByProject.TryGetValue(assemblyName, out var tags) ? tags : [],
        relations,
    };
}

var boundaryId = IdOf(boundaryLabel);
var model = new
{
    elements,
    boundaries = new Dictionary<string, object>
    {
        [boundaryId] = new
        {
            name = boundaryId,
            label = boundaryLabel,
            kind = "Container",
            tags = Array.Empty<string>(),
            elementNames = elements.Keys.ToArray(),
            boundaryNames = Array.Empty<string>(),
        },
    },
    rootBoundaryNames = new[] { boundaryId },
};

Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
File.WriteAllText(
    outputPath,
    JsonSerializer.Serialize(
        new { schemaVersion = 1, model },
        new JsonSerializerOptions { WriteIndented = true }) + Environment.NewLine);

Console.WriteLine($"{elements.Count} assemblies, {edgeCount} references → {outputPath}");
return 0;
