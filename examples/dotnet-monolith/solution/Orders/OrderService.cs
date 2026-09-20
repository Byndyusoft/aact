namespace Orders;

/// <summary>
///     Places orders. The intended architecture lets Orders use
///     Inventory.Contracts only; this code reaches into Inventory.Internal
///     instead, so both adapters have a real violation to report.
/// </summary>
public sealed class OrderService
{
    public bool Place(int quantity) =>
        new Inventory.Internal.InventoryService().Reserve(quantity);
}
