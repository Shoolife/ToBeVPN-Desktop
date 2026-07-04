use std::ffi::c_void;
use std::net::Ipv4Addr;
use std::ptr;

use windows::Win32::Foundation::{ERROR_NOT_FOUND, ERROR_SUCCESS};
use windows::Win32::NetworkManagement::IpHelper::{
    ConvertInterfaceIndexToLuid, ConvertInterfaceLuidToAlias, CreateIpForwardEntry2,
    DeleteIpForwardEntry2, FreeMibTable, GetIpForwardTable2, GetIpInterfaceEntry,
    InitializeIpForwardEntry, InitializeIpInterfaceEntry, IP_ADDRESS_PREFIX, MIB_IPFORWARD_ROW2,
    MIB_IPFORWARD_TABLE2, MIB_IPINTERFACE_ROW,
};
use windows::Win32::NetworkManagement::Ndis::NET_LUID_LH;
use windows::Win32::Networking::WinSock::{
    ADDRESS_FAMILY, AF_INET, IN_ADDR, IN_ADDR_0, IN_ADDR_0_0, MIB_IPPROTO_NETMGMT, SOCKADDR_IN,
    SOCKADDR_INET,
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
            let interface_alias = interface_alias(row.InterfaceIndex);
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

fn ipv4_routes() -> Result<Vec<MIB_IPFORWARD_ROW2>, String> {
    let mut raw_table = ptr::null_mut();
    let status = unsafe { GetIpForwardTable2(AF_INET, &mut raw_table) };
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

fn interface_alias(interface_index: u32) -> Option<String> {
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
