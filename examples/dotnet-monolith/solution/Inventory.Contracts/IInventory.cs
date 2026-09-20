namespace Inventory.Contracts;

/// <summary>Public reservation contract of the Inventory module.</summary>
public interface IInventory
{
    bool Reserve(int quantity);
}
