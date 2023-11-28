# ������ ������ ���������� ��������

## ������

������ - ��� ��������� ������ ����������� ����� ���������. ������ ���������� � ��������� �����.

������ ������ ����� ����������� ������ �, ��������, ������ � �����������.

���� ������ ����� ������������ ������ ������, �� ������ ����� ����������� ������. ������ � ������ ������� ������ �� ������ ������� ��������.

����������� ������� ������ ������������ ��������������� ���� ��� ������. 

## �����

������� ������� ������������ ��� ����� ������� ����� ����� �������� � ���� ���� � ������ ���������, ��� ��� ����� �� ����������.

����� �� ����� ���������� � ����� ����������� �� CI/CD ��� ������� ���� �����.

.net ����� - ���� ���������� � ������� ������ ������, �� �� ������������ �� ���� �� ���� ���, �� � ���������������� ������ �� ����� ������ �� ������ �� ������� �������. 

������ ��������

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
        Contract = "Monolith.Api",
        Implementation = [],
        InternalReferences = []
    }
};
```

����������� ������������� ���������� �� �������� ��������� � ������ `Architecture.svg` � `DetailedArchitecture.svg`