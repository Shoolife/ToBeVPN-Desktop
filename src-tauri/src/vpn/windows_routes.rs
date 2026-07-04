use std::ffi::c_void;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::ptr;

use windows::Win32::Foundation::{
    ERROR_ALREADY_EXISTS, ERROR_BUFFER_OVERFLOW, ERROR_NOT_FOUND, ERROR_OBJECT_ALREADY_EXISTS,
    ERROR_SUCCESS,
};
use windows::Win32::NetworkManagement::IpHelper::{
    ConvertInterfaceIndexToLuid, ConvertInterfaceLuidToAlias, CreateIpForwardEntry2,
    CreateUnicastIpAddressEntry, DeleteIpForwardEntry2, DeleteUnicastIpAddressEntry, FreeMibTable,
    GetAdaptersAddresses, GetIpForwardTable2, GetIpInterfaceEntry, GetUnicastIpAddressTable,
    InitializeIpForwardEntry, InitializeIpInterfaceEntry, InitializeUnicastIpAddressEntry,
    SetIpInterfaceEntry, GAA_FLAG_INCLUDE_ALL_INTERFACES, GAA_FLAG_SKIP_ANYCAST,
    GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH, IP_ADDRESS_PREFIX,
    MIB_IPFORWARD_ROW2, MIB_IPFORWARD_TABLE2, MIB_IPINTERFACE_ROW, MIB_UNICASTIPADDRESS_ROW,
    MIB_UNICASTIPADDRESS_TABLE,
};
use windows::Win32::NetworkManagement::Ndis::NET_LUID_LH;
use windows::Win32::Networking::WinSock::{
    IpPrefixOriginManual, IpSuffixOriginManual, ADDRESS_FAMILY, AF_INET, AF_INET6, AF_UNSPEC,
    IN6_ADDR, IN6_ADDR_0, IN_ADDR, IN_ADDR_0, IN_ADDR_0_0, MIB_IPPROTO_NETMGMT, SOCKADDR_IN,
    SOCKADDR_IN6, SOCKADDR_IN6_0, SOCKADDR_INET,
};

#[derive(Clone, Debug)]
pub struct PhysicalRoute {
    pub gateway: Ipv4Addr,
    pub interface_index: u32,
    pub interface_alias: Option<String>,
    pub metric: u32,
}

struct RouteTable(*mut MIB_IPFORWARD_TABLE2);

impl Drop for RouteTable {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { FreeMibTable(self.0.cast::<c_void>()) };
        }
    }
}

struct UnicastTable(*mut MIB_UNICASTIPADDRESS_TABLE);

impl Drop for UnicastTable {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { FreeMibTable(self.0.cast::<c_void>()) };
        }
    }
}

pub fn default_ipv4_route(
    excluded_alias: &str,
    excluded_gateway: Ipv4Addr,
) -> Result<PhysicalRoute, String> {
    let rows = ipv4_routes()?;
    rows.into_iter()
        .filter(|row| {
            !row.Loopback
                && row.DestinationPrefix.PrefixLength == 0
                && sockaddr_ipv4(&row.DestinationPrefix.Prefix) == Some(Ipv4Addr::UNSPECIFIED)
                && sockaddr_ipv4(&row.NextHop) != Some(excluded_gateway)
        })
        .filter_map(|row| {
            let gateway = sockaddr_ipv4(&row.NextHop)?;
            let interface_alias = interface_alias_by_index(row.InterfaceIndex);
            if interface_alias
                .as_deref()
                .map(|alias| alias.eq_ignore_ascii_case(excluded_alias))
                .unwrap_or(false)
            {
                return None;
            }
            Some(PhysicalRoute {
                gateway,
                interface_index: row.InterfaceIndex,
                interface_alias,
                metric: row
                    .Metric
                    .saturating_add(interface_metric(row.InterfaceIndex).unwrap_or(0)),
            })
        })
        .min_by_key(|route| route.metric)
        .ok_or_else(|| "Windows IP Helper found no physical IPv4 default route".to_string())
}

pub fn replace_ipv4_route(
    destination: Ipv4Addr,
    prefix_length: u8,
    gateway: Ipv4Addr,
    interface_index: u32,
    metric: u32,
) -> Result<(), String> {
    delete_ipv4_routes(destination, prefix_length, Some(interface_index))?;

    let mut row = MIB_IPFORWARD_ROW2::default();
    unsafe { InitializeIpForwardEntry(&mut row) };
    row.InterfaceIndex = interface_index;
    row.DestinationPrefix = IP_ADDRESS_PREFIX {
        Prefix: sockaddr_v4(destination),
        PrefixLength: prefix_length,
    };
    row.NextHop = sockaddr_v4(gateway);
    row.SitePrefixLength = prefix_length;
    row.Metric = metric;
    row.Protocol = MIB_IPPROTO_NETMGMT;
    row.Loopback = false;
    row.AutoconfigureAddress = false;
    row.Publish = false;
    row.Immortal = false;

    let status = unsafe { CreateIpForwardEntry2(&row) };
    if status == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(format!(
            "CreateIpForwardEntry2 failed with Win32 error {}",
            status.0
        ))
    }
}

pub fn replace_ipv6_route(
    destination: Ipv6Addr,
    prefix_length: u8,
    interface_index: u32,
    metric: u32,
) -> Result<(), String> {
    delete_ipv6_routes(destination, prefix_length, Some(interface_index))?;

    let mut row = MIB_IPFORWARD_ROW2::default();
    unsafe { InitializeIpForwardEntry(&mut row) };
    row.InterfaceIndex = interface_index;
    row.DestinationPrefix = IP_ADDRESS_PREFIX {
        Prefix: sockaddr_v6(destination),
        PrefixLength: prefix_length,
    };
    row.NextHop = sockaddr_v6(Ipv6Addr::UNSPECIFIED);
    row.SitePrefixLength = prefix_length;
    row.Metric = metric;
    row.Protocol = MIB_IPPROTO_NETMGMT;
    row.Loopback = false;
    row.AutoconfigureAddress = false;
    row.Publish = false;
    row.Immortal = false;

    let status = unsafe { CreateIpForwardEntry2(&row) };
    if status == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(format!(
            "CreateIpForwardEntry2 IPv6 failed with Win32 error {}",
            status.0
        ))
    }
}

pub fn delete_ipv4_routes(
    destination: Ipv4Addr,
    prefix_length: u8,
    interface_index: Option<u32>,
) -> Result<usize, String> {
    let rows = ipv4_routes()?;
    let matching: Vec<_> = rows
        .into_iter()
        .filter(|row| {
            row.DestinationPrefix.PrefixLength == prefix_length
                && sockaddr_ipv4(&row.DestinationPrefix.Prefix) == Some(destination)
                && interface_index
                    .map(|index| row.InterfaceIndex == index)
                    .unwrap_or(true)
        })
        .collect();

    let mut deleted = 0;
    for row in matching {
        let status = unsafe { DeleteIpForwardEntry2(&row) };
        if status == ERROR_SUCCESS {
            deleted += 1;
        } else if status != ERROR_NOT_FOUND {
            return Err(format!(
                "DeleteIpForwardEntry2 failed with Win32 error {}",
                status.0
            ));
        }
    }
    Ok(deleted)
}

pub fn delete_ipv6_routes(
    destination: Ipv6Addr,
    prefix_length: u8,
    interface_index: Option<u32>,
) -> Result<usize, String> {
    let rows = ip_routes(AF_INET6)?;
    let matching: Vec<_> = rows
        .into_iter()
        .filter(|row| {
            row.DestinationPrefix.PrefixLength == prefix_length
                && sockaddr_ipv6(&row.DestinationPrefix.Prefix) == Some(destination)
                && interface_index
                    .map(|index| row.InterfaceIndex == index)
                    .unwrap_or(true)
        })
        .collect();

    let mut deleted = 0;
    for row in matching {
        let status = unsafe { DeleteIpForwardEntry2(&row) };
        if status == ERROR_SUCCESS {
            deleted += 1;
        } else if status != ERROR_NOT_FOUND {
            return Err(format!(
                "DeleteIpForwardEntry2 IPv6 failed with Win32 error {}",
                status.0
            ));
        }
    }
    Ok(deleted)
}

pub fn delete_interface_ipv4_addresses(interface_index: u32) -> Result<usize, String> {
    delete_unicast_addresses(AF_INET, interface_index, None)
}

pub fn delete_interface_ipv6_address(
    interface_index: u32,
    address: Ipv6Addr,
) -> Result<usize, String> {
    delete_unicast_addresses(AF_INET6, interface_index, Some(IpAddress::V6(address)))
}

pub fn ensure_ipv4_address(
    interface_index: u32,
    address: Ipv4Addr,
    prefix_length: u8,
) -> Result<(), String> {
    if has_unicast_address(AF_INET, interface_index, IpAddress::V4(address))? {
        return Ok(());
    }
    create_unicast_address(interface_index, sockaddr_v4(address), prefix_length, "IPv4")
}

pub fn ensure_ipv6_address(
    interface_index: u32,
    address: Ipv6Addr,
    prefix_length: u8,
) -> Result<(), String> {
    if has_unicast_address(AF_INET6, interface_index, IpAddress::V6(address))? {
        return Ok(());
    }
    create_unicast_address(interface_index, sockaddr_v6(address), prefix_length, "IPv6")
}

pub fn set_ipv4_interface_metric(interface_index: u32, metric: u32) -> Result<(), String> {
    set_interface_metric(AF_INET, interface_index, metric, "IPv4")
}

pub fn set_ipv6_interface_metric(interface_index: u32, metric: u32) -> Result<(), String> {
    set_interface_metric(AF_INET6, interface_index, metric, "IPv6")
}

/// True once Windows has bound the IPv4 stack to this interface. The wintun
/// adapter shows up in GetAdaptersAddresses a beat before its IP interface is
/// ready; assigning an address too early fails with ERROR_NOT_FOUND (1168).
pub fn ipv4_interface_ready(interface_index: u32) -> bool {
    ip_interface_ready(AF_INET, interface_index)
}

/// True once Windows has bound the IPv6 stack to this interface.
pub fn ipv6_interface_ready(interface_index: u32) -> bool {
    ip_interface_ready(AF_INET6, interface_index)
}

fn ip_interface_ready(family: ADDRESS_FAMILY, interface_index: u32) -> bool {
    let mut row = MIB_IPINTERFACE_ROW::default();
    unsafe { InitializeIpInterfaceEntry(&mut row) };
    row.Family = family;
    row.InterfaceIndex = interface_index;
    unsafe { GetIpInterfaceEntry(&mut row) } == ERROR_SUCCESS
}

pub fn adapter_index_by_alias(alias: &str) -> Option<u32> {
    let adapters = adapters().ok()?;
    adapters.into_iter().find_map(|adapter| {
        adapter
            .friendly_name
            .eq_ignore_ascii_case(alias)
            .then_some(adapter.interface_index)
    })
}

pub fn interface_alias_by_index(interface_index: u32) -> Option<String> {
    let mut luid = NET_LUID_LH::default();
    if unsafe { ConvertInterfaceIndexToLuid(interface_index, &mut luid) } != ERROR_SUCCESS {
        return None;
    }

    let mut alias = [0u16; 257];
    if unsafe { ConvertInterfaceLuidToAlias(&luid, &mut alias) } != ERROR_SUCCESS {
        return None;
    }
    let length = alias.iter().position(|ch| *ch == 0).unwrap_or(alias.len());
    String::from_utf16(&alias[..length])
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn ipv4_routes() -> Result<Vec<MIB_IPFORWARD_ROW2>, String> {
    ip_routes(AF_INET)
}

fn ip_routes(family: ADDRESS_FAMILY) -> Result<Vec<MIB_IPFORWARD_ROW2>, String> {
    let mut raw_table = ptr::null_mut();
    let status = unsafe { GetIpForwardTable2(family, &mut raw_table) };
    if status != ERROR_SUCCESS {
        return Err(format!(
            "GetIpForwardTable2 failed with Win32 error {}",
            status.0
        ));
    }
    if raw_table.is_null() {
        return Err("GetIpForwardTable2 returned a null table".into());
    }

    let table = RouteTable(raw_table);
    let row_count = unsafe { (*table.0).NumEntries as usize };
    let first_row = unsafe { (*table.0).Table.as_ptr() };
    Ok(unsafe { std::slice::from_raw_parts(first_row, row_count) }.to_vec())
}

fn interface_metric(interface_index: u32) -> Option<u32> {
    let mut row = MIB_IPINTERFACE_ROW::default();
    unsafe { InitializeIpInterfaceEntry(&mut row) };
    row.Family = AF_INET;
    row.InterfaceIndex = interface_index;
    if unsafe { GetIpInterfaceEntry(&mut row) } == ERROR_SUCCESS {
        Some(row.Metric)
    } else {
        None
    }
}

fn set_interface_metric(
    family: ADDRESS_FAMILY,
    interface_index: u32,
    metric: u32,
    label: &str,
) -> Result<(), String> {
    let mut row = MIB_IPINTERFACE_ROW::default();
    unsafe { InitializeIpInterfaceEntry(&mut row) };
    row.Family = family;
    row.InterfaceIndex = interface_index;

    let status = unsafe { GetIpInterfaceEntry(&mut row) };
    if status != ERROR_SUCCESS {
        return Err(format!(
            "GetIpInterfaceEntry {label} failed with Win32 error {}",
            status.0
        ));
    }

    row.UseAutomaticMetric = false;
    row.Metric = metric;
    let status = unsafe { SetIpInterfaceEntry(&mut row) };
    if status == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(format!(
            "SetIpInterfaceEntry {label} failed with Win32 error {}",
            status.0
        ))
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum IpAddress {
    V4(Ipv4Addr),
    V6(Ipv6Addr),
}

fn create_unicast_address(
    interface_index: u32,
    address: SOCKADDR_INET,
    prefix_length: u8,
    label: &str,
) -> Result<(), String> {
    let mut row = MIB_UNICASTIPADDRESS_ROW::default();
    unsafe { InitializeUnicastIpAddressEntry(&mut row) };
    row.Address = address;
    row.InterfaceIndex = interface_index;
    row.OnLinkPrefixLength = prefix_length;
    row.PrefixOrigin = IpPrefixOriginManual;
    row.SuffixOrigin = IpSuffixOriginManual;
    row.SkipAsSource = false;

    let status = unsafe { CreateUnicastIpAddressEntry(&row) };
    if status == ERROR_SUCCESS
        || status == ERROR_ALREADY_EXISTS
        || status == ERROR_OBJECT_ALREADY_EXISTS
    {
        Ok(())
    } else {
        Err(format!(
            "CreateUnicastIpAddressEntry {label} failed with Win32 error {}",
            status.0
        ))
    }
}

fn has_unicast_address(
    family: ADDRESS_FAMILY,
    interface_index: u32,
    address: IpAddress,
) -> Result<bool, String> {
    Ok(unicast_addresses(family)?.into_iter().any(|row| {
        row.InterfaceIndex == interface_index && unicast_row_address(&row) == Some(address)
    }))
}

fn delete_unicast_addresses(
    family: ADDRESS_FAMILY,
    interface_index: u32,
    address: Option<IpAddress>,
) -> Result<usize, String> {
    let rows: Vec<_> = unicast_addresses(family)?
        .into_iter()
        .filter(|row| {
            row.InterfaceIndex == interface_index
                && address
                    .map(|address| unicast_row_address(row) == Some(address))
                    .unwrap_or(true)
        })
        .collect();

    let mut deleted = 0;
    for row in rows {
        let status = unsafe { DeleteUnicastIpAddressEntry(&row) };
        if status == ERROR_SUCCESS {
            deleted += 1;
        } else if status != ERROR_NOT_FOUND {
            return Err(format!(
                "DeleteUnicastIpAddressEntry failed with Win32 error {}",
                status.0
            ));
        }
    }
    Ok(deleted)
}

fn unicast_addresses(family: ADDRESS_FAMILY) -> Result<Vec<MIB_UNICASTIPADDRESS_ROW>, String> {
    let mut raw_table = ptr::null_mut();
    let status = unsafe { GetUnicastIpAddressTable(family, &mut raw_table) };
    if status != ERROR_SUCCESS {
        return Err(format!(
            "GetUnicastIpAddressTable failed with Win32 error {}",
            status.0
        ));
    }
    if raw_table.is_null() {
        return Err("GetUnicastIpAddressTable returned a null table".into());
    }

    let table = UnicastTable(raw_table);
    let row_count = unsafe { (*table.0).NumEntries as usize };
    let first_row = unsafe { (*table.0).Table.as_ptr() };
    Ok(unsafe { std::slice::from_raw_parts(first_row, row_count) }.to_vec())
}

fn unicast_row_address(row: &MIB_UNICASTIPADDRESS_ROW) -> Option<IpAddress> {
    sockaddr_ipv4(&row.Address)
        .map(IpAddress::V4)
        .or_else(|| sockaddr_ipv6(&row.Address).map(IpAddress::V6))
}

#[derive(Debug)]
struct AdapterInfo {
    friendly_name: String,
    interface_index: u32,
}

fn adapters() -> Result<Vec<AdapterInfo>, String> {
    let mut size = 15_000u32;
    loop {
        let entry_size = std::mem::size_of::<IP_ADAPTER_ADDRESSES_LH>();
        let entry_count = (size as usize + entry_size - 1) / entry_size;
        let mut buffer = vec![IP_ADAPTER_ADDRESSES_LH::default(); entry_count.max(1)];
        let status = unsafe {
            GetAdaptersAddresses(
                AF_UNSPEC.0 as u32,
                GAA_FLAG_INCLUDE_ALL_INTERFACES
                    | GAA_FLAG_SKIP_ANYCAST
                    | GAA_FLAG_SKIP_MULTICAST
                    | GAA_FLAG_SKIP_DNS_SERVER,
                None,
                Some(buffer.as_mut_ptr()),
                &mut size,
            )
        };

        if status == ERROR_BUFFER_OVERFLOW.0 {
            continue;
        }
        if status != ERROR_SUCCESS.0 {
            return Err(format!(
                "GetAdaptersAddresses failed with Win32 error {}",
                status
            ));
        }

        let mut out = Vec::new();
        let mut current = buffer.as_ptr();
        while !current.is_null() {
            let adapter = unsafe { &*current };
            if let Some(friendly_name) = pwstr_to_string(adapter.FriendlyName) {
                let if_index = unsafe { adapter.Anonymous1.Anonymous.IfIndex };
                let interface_index = if if_index != 0 {
                    if_index
                } else {
                    adapter.Ipv6IfIndex
                };
                if interface_index != 0 {
                    out.push(AdapterInfo {
                        friendly_name,
                        interface_index,
                    });
                }
            }
            current = adapter.Next;
        }
        return Ok(out);
    }
}

fn pwstr_to_string(value: windows::core::PWSTR) -> Option<String> {
    if value.is_null() {
        return None;
    }
    unsafe { value.to_string() }
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn sockaddr_v4(ip: Ipv4Addr) -> SOCKADDR_INET {
    let [s_b1, s_b2, s_b3, s_b4] = ip.octets();
    SOCKADDR_INET {
        Ipv4: SOCKADDR_IN {
            sin_family: AF_INET,
            sin_port: 0,
            sin_addr: IN_ADDR {
                S_un: IN_ADDR_0 {
                    S_un_b: IN_ADDR_0_0 {
                        s_b1,
                        s_b2,
                        s_b3,
                        s_b4,
                    },
                },
            },
            sin_zero: [0; 8],
        },
    }
}

fn sockaddr_v6(ip: Ipv6Addr) -> SOCKADDR_INET {
    SOCKADDR_INET {
        Ipv6: SOCKADDR_IN6 {
            sin6_family: AF_INET6,
            sin6_port: 0,
            sin6_flowinfo: 0,
            sin6_addr: IN6_ADDR {
                u: IN6_ADDR_0 { Byte: ip.octets() },
            },
            Anonymous: SOCKADDR_IN6_0 { sin6_scope_id: 0 },
        },
    }
}

fn sockaddr_ipv4(address: &SOCKADDR_INET) -> Option<Ipv4Addr> {
    let family: ADDRESS_FAMILY = unsafe { address.si_family };
    if family != AF_INET {
        return None;
    }
    let octets = unsafe { address.Ipv4.sin_addr.S_un.S_un_b };
    Some(Ipv4Addr::new(
        octets.s_b1,
        octets.s_b2,
        octets.s_b3,
        octets.s_b4,
    ))
}

fn sockaddr_ipv6(address: &SOCKADDR_INET) -> Option<Ipv6Addr> {
    let family: ADDRESS_FAMILY = unsafe { address.si_family };
    if family != AF_INET6 {
        return None;
    }
    let octets = unsafe { address.Ipv6.sin6_addr.u.Byte };
    Some(Ipv6Addr::from(octets))
}
