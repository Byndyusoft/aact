using Inventory.Contracts;

namespace Inventory.Internal;

/// <summary>Inventory-owned implementation. Other modules go through IInventory.</summary>
public sealed class InventoryService : IInventory
{
    private int _available = 10;

    public bool Reserve(int quantity)
    {
        if (quantity > _available) return false;

        _available -= quantity;
        return true;
    }
}
